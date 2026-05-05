// protocol_config_cache.js
//
// Verifies the 60s TTL cache effectiveness in @elisym/sdk's getProtocolConfig.
// Hits the bridge's /protocol-config endpoint at high frequency and measures:
//   - p95 latency (cache hits should be sub-ms-side, network calls dominate cold).
//   - whether bridge metric `elisym_bridge_call_duration_seconds` matches k6
//     side latency (sanity check that bridge does not become the bottleneck).
//
// Default knobs are deliberately conservative so you can run this against a
// freshly booted test-validator without exhausting the program's read budget.

import { check } from 'k6';
import http from 'k6/http';
import { Counter, Trend, Rate } from 'k6/metrics';
import { BRIDGE_URL, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const TARGET_RPS = intEnv('TARGET_RPS', 50);
const DURATION_S = intEnv('DURATION_S', 60);
const NETWORK = __ENV.NETWORK || 'devnet';

const latency = new Trend('config_call_ms', true);
const bridgeOnly = new Trend('config_bridge_elapsed_ms', true);
const errors = new Counter('config_errors_total');
const ok = new Rate('config_success_rate');

export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: Math.max(10, Math.ceil(TARGET_RPS / 5)),
      maxVUs: Math.max(50, TARGET_RPS),
    },
  },
  thresholds: {
    config_call_ms: ['p(95)<200', 'p(99)<1000'],
    config_success_rate: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy (status ${probe.status})`);
  }
  return { bridgeUrl: BRIDGE_URL };
}

export default function () {
  const start = Date.now();
  const res = http.post(`${BRIDGE_URL}/protocol-config`, JSON.stringify({ network: NETWORK }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const elapsed = Date.now() - start;

  const success = res.status === 200;
  ok.add(success);
  latency.add(elapsed);
  if (!success) {
    errors.add(1);
    return;
  }
  let body;
  try {
    body = res.json();
  } catch (_err) {
    errors.add(1);
    return;
  }
  if (typeof body?.elapsedMs === 'number') {
    bridgeOnly.add(body.elapsedMs);
  }
  check(res, {
    'protocol-config returns config': (r) => {
      const j = r.json();
      return Boolean(j?.config);
    },
  });
}

export function handleSummary(data) {
  return writeSummary(data);
}
