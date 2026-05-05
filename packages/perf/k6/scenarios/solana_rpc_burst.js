// solana_rpc_burst.js
//
// Q3 sub-scenario: how does our RPC layer hold under burst?
// Useful as a baseline before payment_full_flow runs - if the RPC itself is
// the bottleneck, the SDK numbers will be misleading.
//
// Methodology:
//   - Three RPS shapes (light, medium, heavy) issued with constant-arrival-rate.
//   - Per-method tagging: getSlot, getBlockHeight, getLatestBlockhash, getBalance.
//   - Records latency per method, error rate, 429 rate.
//
// Defaults are set for solana-test-validator on localhost:8899. Pass
// RPC_URL=https://api.devnet.solana.com to retarget at devnet (be gentle).

import { Trend, Counter, Rate } from 'k6/metrics';
import { RPC_URL, intEnv } from '../lib/env.js';
import { rpcCall, pingRpc } from '../lib/solana-rpc.js';
import { writeSummary } from '../lib/stats.js';

const PROBE_ADDRESS = __ENV.PROBE_ADDRESS || 'Vote111111111111111111111111111111111111111';
const HEAVY_RPS = intEnv('HEAVY_RPS', 200);
const MEDIUM_RPS = intEnv('MEDIUM_RPS', 100);
const LIGHT_RPS = intEnv('LIGHT_RPS', 25);
const STAGE_S = intEnv('STAGE_S', 30);

const latency = new Trend('rpc_latency_ms', true);
const errors = new Counter('rpc_errors_total');
const ratelimits = new Counter('rpc_ratelimit_total');
const successRate = new Rate('rpc_success_rate');

export const options = {
  scenarios: {
    light: rate(LIGHT_RPS, STAGE_S, 0),
    medium: rate(MEDIUM_RPS, STAGE_S, STAGE_S + 5),
    heavy: rate(HEAVY_RPS, STAGE_S, (STAGE_S + 5) * 2),
  },
  thresholds: {
    rpc_latency_ms: ['p(95)<500', 'p(99)<2000'],
    rpc_success_rate: ['rate>0.95'],
    rpc_ratelimit_total: ['count<50'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

function rate(rps, durationSeconds, startSeconds) {
  return {
    executor: 'constant-arrival-rate',
    rate: rps,
    timeUnit: '1s',
    duration: `${durationSeconds}s`,
    preAllocatedVUs: Math.max(10, Math.ceil(rps / 5)),
    maxVUs: Math.max(50, rps),
    startTime: `${startSeconds}s`,
    exec: 'oneRequest',
  };
}

export function setup() {
  const ok = pingRpc(RPC_URL);
  if (!ok) {
    throw new Error(
      `RPC ${RPC_URL} did not respond to getHealth - is solana-test-validator running?`,
    );
  }
  return { rpcUrl: RPC_URL };
}

const METHODS = ['getSlot', 'getBlockHeight', 'getLatestBlockhash', 'getBalance'];

export function oneRequest() {
  const method = METHODS[__ITER % METHODS.length];
  const params = method === 'getBalance' ? [PROBE_ADDRESS] : [];
  const r = rpcCall(method, params);
  latency.add(r.durationMs, { method });
  if (r.status === 429) {
    ratelimits.add(1);
  }
  const ok = r.status === 200 && !r.error;
  successRate.add(ok);
  if (!ok) {
    errors.add(1);
  }
}

export function handleSummary(data) {
  return writeSummary(data);
}
