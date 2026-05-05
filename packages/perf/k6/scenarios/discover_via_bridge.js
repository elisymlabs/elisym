// discover_via_bridge.js
//
// Sanity scenario for Phase 3: confirms that bridge -> @elisym/sdk -> relay
// path works end-to-end, and produces a first discovery latency datapoint
// against either the local strfry (no agents announced) or public relays.
//
// This is intentionally a low-RPS smoke. Q1 / Q2 (agent_fleet_scale,
// web_discovery_latency) replace this with a structured sweep.

import http from 'k6/http';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BRIDGE_URL, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const TARGET_RPS = intEnv('TARGET_RPS', 5);
const DURATION_S = intEnv('DURATION_S', 30);
const LIMIT = intEnv('AGENT_LIMIT', 50);
const NETWORK = __ENV.NETWORK || 'devnet';

const latency = new Trend('discover_call_ms', true);
const bridgeOnly = new Trend('discover_bridge_elapsed_ms', true);
const success = new Rate('discover_success_rate');
const counts = new Counter('discover_agents_returned_total');

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: Math.max(5, TARGET_RPS),
      maxVUs: Math.max(20, TARGET_RPS * 2),
    },
  },
  thresholds: {
    discover_call_ms: ['p(95)<5000'],
    discover_success_rate: ['rate>0.9'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy (status ${probe.status})`);
  }
}

export default function () {
  const start = Date.now();
  const res = http.post(
    `${BRIDGE_URL}/discover`,
    JSON.stringify({ network: NETWORK, limit: LIMIT }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '20s' },
  );
  const elapsed = Date.now() - start;
  latency.add(elapsed);

  const ok = res.status === 200;
  success.add(ok);
  if (!ok) {
    return;
  }
  let body;
  try {
    body = res.json();
  } catch (_err) {
    return;
  }
  if (typeof body?.elapsedMs === 'number') {
    bridgeOnly.add(body.elapsedMs);
  }
  if (typeof body?.count === 'number') {
    counts.add(body.count);
  }
}

export function handleSummary(data) {
  return writeSummary(data);
}
