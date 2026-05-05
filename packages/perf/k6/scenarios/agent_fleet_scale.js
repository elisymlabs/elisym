// agent_fleet_scale.js
//
// Q1: how many agents can stay online before discovery degrades?
//
// Methodology:
//   - For each fleet size in FLEET_SIZES (default 0,10,100,500,1000,2500,5000):
//       1. POST /fleet/resize { size }    -> bridge spins synthetic agents.
//       2. Sleep PROPAGATION_S            -> let relay index events.
//       3. Run SAMPLES discovery calls    -> measure latency.
//   - Latency, agents-returned, errors are tagged with `fleet_size` so
//     Grafana can plot a single chart "p50/p95/p99 vs N agents".
//
// Single VU, sequential by design - we want a clean step function, not
// concurrency noise. To stress concurrency at fixed fleet size, see
// `web_discovery_latency.js` (Phase 5).

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Trend, Counter, Rate } from 'k6/metrics';
import { BRIDGE_URL, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const SAMPLES = intEnv('SAMPLES', 10);
const PROPAGATION_S = intEnv('PROPAGATION_S', 5);
const AGENT_LIMIT = intEnv('AGENT_LIMIT', 200);
const NETWORK = __ENV.NETWORK || 'devnet';
const CAPABILITY = __ENV.CAPABILITY || 'translate';
const FLEET_SIZES = (__ENV.FLEET_SIZES || '0,10,100,500,1000,2500,5000')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n >= 0);

const discoverLatency = new Trend('discover_call_ms', true);
const bridgeElapsed = new Trend('discover_bridge_elapsed_ms', true);
const agentsReturned = new Trend('discover_agents_returned');
const errors = new Counter('discover_errors_total');
const successRate = new Rate('discover_success_rate');

export const options = {
  scenarios: {
    sweep: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  // Thresholds intentionally lenient - this scenario maps the curve, it
  // does not gate on a single number.
  thresholds: {
    discover_success_rate: ['rate>0.9'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

function resizeFleet(size) {
  const res = http.post(
    `${BRIDGE_URL}/fleet/resize`,
    JSON.stringify({ size, capability: CAPABILITY }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '120s' },
  );
  check(res, { 'fleet resize 200': (r) => r.status === 200 });
  return res;
}

function discoverOnce(fleetSize) {
  const start = Date.now();
  const res = http.post(
    `${BRIDGE_URL}/discover`,
    JSON.stringify({ network: NETWORK, limit: AGENT_LIMIT }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '30s' },
  );
  const elapsed = Date.now() - start;
  const ok = res.status === 200;
  successRate.add(ok, { fleet_size: String(fleetSize) });
  discoverLatency.add(elapsed, { fleet_size: String(fleetSize) });
  if (!ok) {
    errors.add(1, { fleet_size: String(fleetSize) });
    return;
  }
  let body;
  try {
    body = res.json();
  } catch (_err) {
    errors.add(1, { fleet_size: String(fleetSize) });
    return;
  }
  if (typeof body?.elapsedMs === 'number') {
    bridgeElapsed.add(body.elapsedMs, { fleet_size: String(fleetSize) });
  }
  if (typeof body?.count === 'number') {
    agentsReturned.add(body.count, { fleet_size: String(fleetSize) });
  }
}

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy`);
  }
}

export default function () {
  for (const size of FLEET_SIZES) {
    const t0 = Date.now();
    resizeFleet(size);
    sleep(PROPAGATION_S);
    for (let i = 0; i < SAMPLES; i++) {
      discoverOnce(size);
    }
    const stepDuration = (Date.now() - t0) / 1000;
    // Print a per-step line so the operator can follow long sweeps in stdout.
    console.log(`[step] fleet=${size} samples=${SAMPLES} step_seconds=${stepDuration.toFixed(1)}`);
  }
  // Tear down so the next scenario invocation starts clean.
  const stopRes = http.post(`${BRIDGE_URL}/fleet/stop`, '{}', {
    headers: { 'Content-Type': 'application/json' },
  });
  check(stopRes, { 'fleet stop ok': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return writeSummary(data);
}
