// provider_saturation.js
//
// Q4: how many concurrent jobs does one provider hold?
//
// Methodology:
//   - Constant-arrival-rate flood of broadcast job requests via bridge
//     /job/submit. Submission RPS ramps via stages so we observe the curve.
//   - Provider runs separately on host with `MOCK_LLM=1 elisym start <name>
//     --metrics-port 9464`. Prometheus scrapes its /metrics, so the answer
//     reads off the provider.json Grafana dashboard, not k6 output.
//   - k6 measures only submission-side latency: how fast can we hand the
//     relay a kind:5100 event. Real "time-to-result" is observed via the
//     provider metric `elisym_job_duration_seconds`.
//
// Interpretation: the queue-depth knee is where `elisym_jobs_in_flight`
// pegs at MAX_CONCURRENT_JOBS (=10) and `elisym_jobs_pending` starts to
// climb monotonically.

import http from 'k6/http';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BRIDGE_URL, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const STAGE_S = intEnv('STAGE_S', 30);
const STAGE_RPS = (__ENV.STAGE_RPS || '1,5,15,30,60')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n > 0);
const CAPABILITY = __ENV.CAPABILITY || 'translate';

const submitLatency = new Trend('submit_call_ms', true);
const submitErrors = new Counter('submit_errors_total');
const submitOk = new Rate('submit_success_rate');

function stage(rps, startTimeS) {
  return {
    executor: 'constant-arrival-rate',
    rate: rps,
    timeUnit: '1s',
    duration: `${STAGE_S}s`,
    preAllocatedVUs: Math.max(20, Math.ceil(rps * 1.5)),
    maxVUs: Math.max(50, rps * 4),
    startTime: `${startTimeS}s`,
    exec: 'submit',
    tags: { stage_rps: String(rps) },
  };
}

const scenarios = {};
let cursor = 0;
for (const rps of STAGE_RPS) {
  scenarios[`rps_${rps}`] = stage(rps, cursor);
  cursor += STAGE_S + 5;
}

export const options = {
  scenarios,
  thresholds: {
    submit_success_rate: ['rate>0.95'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy`);
  }
}

export function submit() {
  const start = Date.now();
  const res = http.post(`${BRIDGE_URL}/job/submit`, JSON.stringify({ capability: CAPABILITY }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });
  const elapsed = Date.now() - start;
  submitLatency.add(elapsed);
  const ok = res.status === 200;
  submitOk.add(ok);
  if (!ok) {
    submitErrors.add(1);
  }
}

export function handleSummary(data) {
  return writeSummary(data);
}
