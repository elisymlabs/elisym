// e2e_steady_state.js
//
// Q5: composite "realistic" steady-state load.
//
// What "realistic" means here is operator-tunable. The defaults paint a
// picture of:
//   - SUSTAINED_AGENTS = 500 synthetic agents online via the bridge fleet
//   - DISCOVERY_RPS    = 5 user discovery queries / sec
//   - JOB_RPS          = 1 paid job per minute (1/60 RPS) flooded at the provider
//   - DURATION_MIN     = 10 minutes
//
// Run after agent_fleet_scale + provider_saturation have produced their
// individual numbers. This scenario asks "do those numbers hold when the
// system is doing all four headline activities simultaneously, for long
// enough that drift / leaks would show?"
//
// Dashboards: open `e2e.json` in Grafana. The scenario writes its own k6
// summary; provider/relay/bridge metrics are captured by Prometheus
// throughout via the existing scrape config.

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BRIDGE_URL, intEnv, floatEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const SUSTAINED_AGENTS = intEnv('SUSTAINED_AGENTS', 500);
const DISCOVERY_RPS = intEnv('DISCOVERY_RPS', 5);
const JOB_RPS = floatEnv('JOB_RPS', 1 / 60);
const DURATION_MIN = intEnv('DURATION_MIN', 10);
const NETWORK = __ENV.NETWORK || 'devnet';
const CAPABILITY = __ENV.CAPABILITY || 'translate';

const discoveryLatency = new Trend('discovery_call_ms', true);
const jobSubmitLatency = new Trend('job_submit_call_ms', true);
const discoveryOk = new Rate('discovery_success_rate');
const jobSubmitOk = new Rate('job_submit_success_rate');
const errors = new Counter('e2e_errors_total');

const totalDuration = `${DURATION_MIN}m`;

export const options = {
  scenarios: {
    fleet_keepalive: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: totalDuration,
      exec: 'fleetKeepalive',
    },
    discovery: {
      executor: 'constant-arrival-rate',
      rate: DISCOVERY_RPS,
      timeUnit: '1s',
      duration: totalDuration,
      preAllocatedVUs: Math.max(5, DISCOVERY_RPS),
      maxVUs: Math.max(20, DISCOVERY_RPS * 4),
      startTime: '15s',
      exec: 'discover',
    },
    jobs: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(JOB_RPS * 60)),
      timeUnit: '1m',
      duration: totalDuration,
      preAllocatedVUs: 5,
      maxVUs: 20,
      startTime: '15s',
      exec: 'submitJob',
    },
  },
  thresholds: {
    discovery_success_rate: ['rate>0.95'],
    job_submit_success_rate: ['rate>0.95'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy`);
  }
}

export function teardown() {
  http.post(`${BRIDGE_URL}/fleet/stop`, '{}', {
    headers: { 'Content-Type': 'application/json' },
  });
}

export function fleetKeepalive() {
  const res = http.post(
    `${BRIDGE_URL}/fleet/resize`,
    JSON.stringify({ size: SUSTAINED_AGENTS, capability: CAPABILITY }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '180s' },
  );
  check(res, { 'fleet resize ok': (r) => r.status === 200 });
  // Sleep until end of run; the fleet republishes itself every 2 minutes
  // on its own cadence (see FleetSimulator).
  sleep(DURATION_MIN * 60);
}

export function discover() {
  const start = Date.now();
  const res = http.post(`${BRIDGE_URL}/discover`, JSON.stringify({ network: NETWORK }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '20s',
  });
  const elapsed = Date.now() - start;
  discoveryLatency.add(elapsed);
  const ok = res.status === 200;
  discoveryOk.add(ok);
  if (!ok) {
    errors.add(1, { kind: 'discover' });
  }
}

export function submitJob() {
  const start = Date.now();
  const res = http.post(`${BRIDGE_URL}/job/submit`, JSON.stringify({ capability: CAPABILITY }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });
  const elapsed = Date.now() - start;
  jobSubmitLatency.add(elapsed);
  const ok = res.status === 200;
  jobSubmitOk.add(ok);
  if (!ok) {
    errors.add(1, { kind: 'submit' });
  }
}

export function handleSummary(data) {
  return writeSummary(data);
}
