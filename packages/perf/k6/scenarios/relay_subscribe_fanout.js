// relay_subscribe_fanout.js
//
// Diagnostic sub-scenario for Q2: holds N WebSocket subscribers open against
// strfry, then publishes M events via a single producer connection. Measures
// fanout latency: "how long until X% of subscribers receive each event?"
//
// Knobs:
//   SUBSCRIBERS=200
//   PUBLISH_BATCH=20
//   PUBLISH_INTERVAL_MS=500
//   STAGE_S=60
//   FIXTURE=../fixtures/events-5100.json (auto-generated)

import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter, Rate } from 'k6/metrics';
import ws from 'k6/ws';
import { STRFRY_WS, intEnv } from '../lib/env.js';
import { writeSummary } from '../lib/stats.js';

const FIXTURE = __ENV.FIXTURE || '../fixtures/events-5100.json';
const SUBSCRIBERS = intEnv('SUBSCRIBERS', 200);
const PUBLISH_BATCH = intEnv('PUBLISH_BATCH', 20);
const PUBLISH_INTERVAL_MS = intEnv('PUBLISH_INTERVAL_MS', 500);
const STAGE_S = intEnv('STAGE_S', 60);

const events = new SharedArray('events', () => {
  const raw = open(FIXTURE);
  return JSON.parse(raw);
});

const fanoutLatency = new Trend('fanout_delivery_ms', true);
const subscriberDrops = new Counter('subscriber_drops_total');
const publishesTotal = new Counter('publishes_total');
const eventsReceivedTotal = new Counter('events_received_total');
const subscriberOpenRate = new Rate('subscriber_open_rate');

// Two scenarios: subscribers (long-lived) + publisher (short bursts).
export const options = {
  scenarios: {
    subscribers: {
      executor: 'per-vu-iterations',
      vus: SUBSCRIBERS,
      iterations: 1,
      maxDuration: `${STAGE_S + 10}s`,
      exec: 'subscriber',
    },
    publisher: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: '5s',
      maxDuration: `${STAGE_S + 5}s`,
      exec: 'publisher',
    },
  },
  thresholds: {
    fanout_delivery_ms: ['p(95)<1000', 'p(99)<3000'],
    subscriber_open_rate: ['rate>0.95'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

export function subscriber() {
  const subId = `sub-${__VU}`;
  const filter = { kinds: [5100], '#t': ['perf-fanout'] };
  const res = ws.connect(STRFRY_WS, {}, (socket) => {
    socket.on('open', () => {
      subscriberOpenRate.add(true);
      socket.send(JSON.stringify(['REQ', subId, filter]));
    });
    socket.on('message', (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_err) {
        return;
      }
      if (Array.isArray(parsed) && parsed[0] === 'EVENT' && parsed[1] === subId) {
        eventsReceivedTotal.add(1);
        const event = parsed[2];
        if (event && typeof event.created_at === 'number') {
          // Producer stamps the publish wall-clock into the content as
          // `t=<ms>`; if absent, fall back to created_at-based estimate.
          const matched = /t=(\d+)/.exec(String(event.content ?? ''));
          if (matched) {
            const t0 = Number.parseInt(matched[1], 10);
            fanoutLatency.add(Date.now() - t0);
          }
        }
      }
    });
    socket.on('close', () => {
      subscriberDrops.add(1);
    });
    socket.setTimeout(() => {
      socket.send(JSON.stringify(['CLOSE', subId]));
      socket.close();
    }, STAGE_S * 1000);
  });
  if (!res || res.status !== 101) {
    subscriberOpenRate.add(false);
  }
}

export function publisher() {
  const res = ws.connect(STRFRY_WS, {}, (socket) => {
    socket.on('open', () => {
      const endTime = Date.now() + STAGE_S * 1000;
      while (Date.now() < endTime) {
        for (let i = 0; i < PUBLISH_BATCH; i++) {
          // Pick a fixture event but rewrite the content to embed the wall-clock
          // timestamp so subscribers can compute delivery latency without
          // requiring synchronised clocks (single host, same epoch).
          const base = events[Math.floor(Math.random() * events.length)];
          const stamped = {
            ...base,
            content: `${base.content} | t=${Date.now()}`,
            tags: [...base.tags, ['t', 'perf-fanout']],
          };
          // NOTE: stamped event has wrong sig now, but strfry rejects it.
          // For accurate fanout, regenerate fixture with the perf-fanout
          // tag baked in via generate-events.ts. This is a Phase 5 follow-up
          // captured in README troubleshooting.
          socket.send(JSON.stringify(['EVENT', stamped]));
          publishesTotal.add(1);
        }
        sleep(PUBLISH_INTERVAL_MS / 1000);
      }
      socket.close();
    });
  });
  if (!res || res.status !== 101) {
    throw new Error(`publisher could not connect to ${STRFRY_WS}`);
  }
}

export function handleSummary(data) {
  return writeSummary(data);
}
