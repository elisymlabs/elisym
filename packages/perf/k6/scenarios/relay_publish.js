// relay_publish.js
//
// Phase 1 baseline: how many EVENTs/sec can our local strfry accept?
//
// Methodology:
//   - Pre-signed fixture of N events (generated via packages/perf/scripts/generate-events.ts).
//   - VUs ramp from 1 to TARGET_VUS over WARMUP_S, hold for HOLD_S, ramp down.
//   - Each VU opens one ws connection, publishes events at MAX_VU_RATE evt/sec,
//     measures the OK ack round-trip latency, records both accepted and rejected
//     outcomes. Pre-signed events should all be accepted; rejection signals a bug
//     in the fixture generator or strfry config drift.
//
// Knobs (env):
//   STRFRY_WS=ws://localhost:7777   target relay
//   FIXTURE=/fixtures/events-5100.json (path inside the container OR absolute on host)
//   TARGET_VUS=50
//   WARMUP_S=15
//   HOLD_S=60
//   COOLDOWN_S=10
//   MAX_VU_RATE=20                  events per second per VU

import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { STRFRY_WS, intEnv } from '../lib/env.js';
import { publishEvent } from '../lib/nostr.js';
import { writeSummary } from '../lib/stats.js';

// Path is resolved relative to THIS scenario file by k6's open(); the
// FIXTURE env-var lets a runner inject an absolute path if needed.
const FIXTURE = __ENV.FIXTURE || '../fixtures/events-5100.json';
const TARGET_VUS = intEnv('TARGET_VUS', 50);
const WARMUP_S = intEnv('WARMUP_S', 15);
const HOLD_S = intEnv('HOLD_S', 60);
const COOLDOWN_S = intEnv('COOLDOWN_S', 10);
const MAX_VU_RATE = intEnv('MAX_VU_RATE', 20);

const events = new SharedArray('events', () => {
  const raw = open(FIXTURE);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`fixture ${FIXTURE} is empty or not an array`);
  }
  return parsed;
});

const okLatency = new Trend('relay_ok_latency_ms', true);
const acks = new Counter('relay_acks_total');
const rejects = new Counter('relay_rejects_total');
const sent = new Counter('relay_sent_total');
const errors = new Counter('relay_errors_total');
const acceptRate = new Rate('relay_accept_rate');

export const options = {
  scenarios: {
    publish: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: `${WARMUP_S}s`, target: TARGET_VUS },
        { duration: `${HOLD_S}s`, target: TARGET_VUS },
        { duration: `${COOLDOWN_S}s`, target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    relay_ok_latency_ms: ['p(95)<500', 'p(99)<2000'],
    relay_accept_rate: ['rate>0.99'],
    relay_errors_total: ['count<10'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export default function () {
  const periodMs = Math.max(1, Math.floor(1000 / MAX_VU_RATE));
  let cursor = (__VU * 7919 + __ITER) % events.length;

  const res = ws.connect(STRFRY_WS, {}, (socket) => {
    socket.on('open', () => {
      const tickerEnd = Date.now() + 1000;
      while (Date.now() < tickerEnd) {
        const event = events[cursor];
        cursor = (cursor + 1) % events.length;
        publishEvent(socket, event, {
          okTrend: okLatency,
          sentCounter: sent,
          ackCounter: acks,
          errorCounter: rejects,
          onResolve: (_id, accepted) => {
            acceptRate.add(accepted);
          },
        });
        sleep(periodMs / 1000);
      }
      socket.close();
    });

    socket.on('error', () => {
      errors.add(1);
    });
  });

  check(res, { 'ws handshake 101': (r) => r && r.status === 101 });
}

export function handleSummary(data) {
  return writeSummary(data);
}
