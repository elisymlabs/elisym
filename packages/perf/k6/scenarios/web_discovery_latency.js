// web_discovery_latency.js
//
// Q2: how fast does an end user see search results in the web app?
//
// Mirrors what `packages/app` does on cold start: subscribe to NIP-89 events
// via `streamAgents`, render cards as they arrive, fire enrichment on EOSE.
// The bridge's /stream-discover endpoint exposes this exact sequence with
// server-measured timestamps so we can report:
//
//   - time-to-first-card (TTF): first onAgent callback
//   - time-to-N-cards     (TTN): first time count >= TARGET_AGENTS_N
//   - time-to-EOSE        (TTE): all relays replied
//   - time-to-complete    (TTC): enrichment done, ranking finalised
//
// Designed to run AFTER /fleet/resize has populated the relay (e.g. 500
// agents). Run agent_fleet_scale first or invoke /fleet/resize manually.
//
// Cold-cache only for now. Browser-side warm-cache (IndexedDB hit) is a
// separate optional scenario `web_browser_smoke.js` that drives a real
// vite preview - meaningful when there's a real persistent cache.

import http from 'k6/http';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BRIDGE_URL, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const VUS = intEnv('VUS', 10);
const ITERATIONS_PER_VU = intEnv('ITERATIONS_PER_VU', 5);
const TIMEOUT_MS = intEnv('TIMEOUT_MS', 30_000);
const TARGET_AGENTS_N = intEnv('TARGET_AGENTS_N', 10);
const SAMPLE_EVERY_N = intEnv('SAMPLE_EVERY_N', TARGET_AGENTS_N);
const NETWORK = __ENV.NETWORK || 'devnet';

const ttf = new Trend('ttf_first_card_ms', true);
const ttn = new Trend('ttn_n_cards_ms', true);
const tte = new Trend('tte_eose_ms', true);
const ttc = new Trend('ttc_complete_ms', true);
const finalCount = new Trend('final_agent_count');
const timeouts = new Counter('stream_timeouts_total');
const success = new Rate('stream_success_rate');

export const options = {
  scenarios: {
    cold: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERATIONS_PER_VU,
      maxDuration: '15m',
    },
  },
  thresholds: {
    stream_success_rate: ['rate>0.95'],
    ttf_first_card_ms: ['p(95)<5000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function setup() {
  const probe = http.get(`${BRIDGE_URL}/healthz`, { timeout: '2s' });
  if (probe.status !== 200) {
    throw new Error(`bridge ${BRIDGE_URL} not healthy`);
  }
}

export default function () {
  const res = http.post(
    `${BRIDGE_URL}/stream-discover`,
    JSON.stringify({ network: NETWORK, timeoutMs: TIMEOUT_MS, sampleEveryN: SAMPLE_EVERY_N }),
    { headers: { 'Content-Type': 'application/json' }, timeout: `${TIMEOUT_MS + 5000}ms` },
  );

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

  if (typeof body?.firstAgentDeltaMs === 'number') {
    ttf.add(body.firstAgentDeltaMs);
  }
  if (typeof body?.finalCount === 'number') {
    finalCount.add(body.finalCount);
  }
  if (body?.timedOut) {
    timeouts.add(1);
  }

  const milestones = Array.isArray(body?.milestones) ? body.milestones : [];
  for (const m of milestones) {
    if (m.event === 'eose' && typeof m.deltaMs === 'number') {
      tte.add(m.deltaMs);
    } else if (m.event === 'complete' && typeof m.deltaMs === 'number') {
      ttc.add(m.deltaMs);
    } else if (
      m.event === 'n-agents' &&
      typeof m.deltaMs === 'number' &&
      m.index === TARGET_AGENTS_N
    ) {
      ttn.add(m.deltaMs);
    }
  }
}

export function handleSummary(data) {
  return writeSummary(data);
}
