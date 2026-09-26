import { buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import { type Filter, type NostrEvent, matchFilter } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  InboxListener,
  type ListenerPool,
  PAGE_WAIT_MS,
  SeenWraps,
  nextPageUntil,
  readSince,
  resumePointAfterSweep,
  wrapFilter,
} from '../src/listener';
import { T0, key } from './fixtures';

const RELAY = 'wss://inbox.example.com';

interface Recorded {
  filter: Filter;
  params: Parameters<ListenerPool['subscribe']>[2];
  closed: boolean;
}

/** nostr-tools' own EOSE timeout when no `maxWait` is given (`relay.baseEoseTimeout`). */
const LIBRARY_DEFAULT_EOSE_MS = 4400;

/**
 * A relay in memory: `subscribe` is scripted, `subscribeEose` serves `stored`
 * newest first, `cap` per page. Like nostr-tools, a page that gets no answer is
 * ended by the library's EOSE timeout - `maxWait`, or 4.4 s without it - and
 * reported exactly like a real EOSE.
 */
class FakePool implements ListenerPool {
  constructor(private readonly timers: Timers) {}

  live: Recorded[] = [];
  pages: Recorded[] = [];
  stored: NostrEvent[] = [];
  cap = 1000;
  /** How a backfill page ends: EOSE, a refusal, or never (a timeout must end it). */
  pageEnd: 'eose' | 'refused' | 'hang' = 'eose';

  subscribe(_relays: string[], filter: Filter, params: Recorded['params']) {
    const entry: Recorded = { filter, params, closed: false };
    this.live.push(entry);
    return { close: () => (entry.closed = true) };
  }

  subscribeEose(_relays: string[], filter: Filter, params: Recorded['params']) {
    const entry: Recorded = { filter, params, closed: false };
    this.pages.push(entry);
    const close = (reason: string) => {
      if (!entry.closed) {
        entry.closed = true;
        params.onclose?.([reason]);
      }
    };
    queueMicrotask(() => {
      if (this.pageEnd === 'hang') {
        this.timers.set(
          () => close('closed automatically on eose'),
          params.maxWait ?? LIBRARY_DEFAULT_EOSE_MS,
        );
        return;
      }
      if (this.pageEnd === 'refused') {
        close('auth-required: sign in');
        return;
      }
      const page = this.stored
        .filter((event) => matchFilter(filter, event))
        .sort((left, right) => right.created_at - left.created_at)
        .slice(0, this.cap);
      for (const event of page) {
        params.onevent(event);
      }
      close('closed automatically on eose');
    });
    return { close: () => close('closed by caller') };
  }
}

/** Timers the test runs by hand. */
class Timers {
  queue: { task: () => void; ms: number }[] = [];
  set = (task: () => void, ms: number) => {
    const timer = { task, ms };
    this.queue.push(timer);
    return () => {
      this.queue = this.queue.filter((queued) => queued !== timer);
    };
  };
  /** Run (and remove) every queued timer of at most `ms`. */
  run(ms = 0) {
    const due = this.queue.filter((timer) => timer.ms <= ms);
    this.queue = this.queue.filter((timer) => timer.ms > ms);
    for (const timer of due) {
      timer.task();
    }
  }
}

async function settle() {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

const store = key();
const sender = key();

function wrapAt(createdAt: number, label: string): NostrEvent {
  return finalizeEvent(
    { kind: 1059, created_at: createdAt, tags: [['p', store.pubkey]], content: label },
    sender.secretKey,
  );
}

function setup(now = T0) {
  const timers = new Timers();
  const pool = new FakePool(timers);
  const received: NostrEvent[] = [];
  const logs: string[] = [];
  const listener = new InboxListener({
    pool,
    storePubkey: store.pubkey,
    auth: async (template) => finalizeEvent(template, store.secretKey),
    onWrap: (wrap) => received.push(wrap),
    log: (message) => logs.push(message),
    now: () => now,
    setTimer: timers.set,
  });
  return { pool, timers, received, logs, listener };
}

describe('the live filter', () => {
  it('lets through a fresh wrap, though NIP-59 dates it up to two days back', () => {
    const buyer = key();
    const filter = wrapFilter(store.pubkey, readSince(Math.floor(Date.now() / 1000)));
    for (let index = 0; index < 50; index += 1) {
      const rumor = buildOrderMessage({
        type: 'order',
        storePubkey: store.pubkey,
        orderId: `b3a7c2d4-0000-4000-8000-0000000c${String(index).padStart(4, '0')}`,
        items: [{ product: `30402:${store.pubkey}:x`, quantity: 1 }],
        total: { amount: '1', currency: 'USD' },
      });
      const { recipientWrap } = wrapOrderMessage(rumor, buyer.secretKey, store.pubkey);
      expect(matchFilter(filter, recipientWrap)).toBe(true);
    }
  });
});

describe('readSince', () => {
  it('reaches two days back and the skew allowance beyond', () => {
    expect(readSince(T0)).toBe(T0 - 2 * 24 * 60 * 60 - 15 * 60);
  });
});

describe('nextPageUntil', () => {
  it('pages below the oldest wrap, steps a second down on a page stuck in one second, and ends', () => {
    expect(nextPageUntil(100, 500, 0, 500)).toBeUndefined();
    expect(nextPageUntil(100, 500, 10, 300)).toBe(300);
    expect(nextPageUntil(100, 500, 10, 500)).toBe(499);
    expect(nextPageUntil(100, 500, 10, 100)).toBeUndefined();
    expect(nextPageUntil(100, 101, 10, 101)).toBeUndefined();
  });
});

describe('backfill', () => {
  it('reads every stored wrap past a flood of junk sharing one second', async () => {
    const { pool, timers, received, listener } = setup();
    pool.cap = 5;
    const real = [wrapAt(T0 - 300, 'a'), wrapAt(T0 - 200, 'b'), wrapAt(T0 - 100, 'c')];
    const junk = Array.from({ length: 8 }, (_, index) => wrapAt(T0 - 10, `junk-${index}`));
    pool.stored = [...real, ...junk];
    const done = listener.backfill(RELAY, T0 - 1000, T0);
    for (let turn = 0; turn < 10; turn += 1) {
      await settle();
      timers.run(0);
    }
    expect(await done).toBe(true);
    for (const wrap of real) {
      expect(received.map((event) => event.id)).toContain(wrap.id);
    }
  });

  it('is not read through when the relay refuses, or never answers in time', async () => {
    const refused = setup();
    refused.pool.pageEnd = 'refused';
    const answer = refused.listener.backfill(RELAY, T0 - 1000, T0);
    await settle();
    expect(await answer).toBe(false);

    const silent = setup();
    silent.pool.pageEnd = 'hang';
    const waiting = silent.listener.backfill(RELAY, T0 - 1000, T0);
    await settle();
    // The library would report a fake EOSE; the page's own, shorter timer ends it first.
    expect(silent.pool.pages[0]?.params.maxWait).toBeGreaterThan(PAGE_WAIT_MS);
    silent.timers.run(PAGE_WAIT_MS);
    expect(await waiting).toBe(false);
  });

  it('clears its page timer once the page ends', async () => {
    const { pool, timers, listener } = setup();
    pool.stored = [wrapAt(T0 - 10, 'a')];
    const done = listener.backfill(RELAY, T0 - 1000, T0);
    await settle();
    timers.run(0);
    await settle();
    expect(await done).toBe(true);
    expect(timers.queue).toEqual([]);
  });
});

describe('listen, retries and the resume point', () => {
  it('tries a failed backfill again, and goes live once it reads through', async () => {
    const { pool, timers, listener } = setup();
    pool.pageEnd = 'refused';
    listener.listen(RELAY, T0);
    pool.live[0]?.params.oneose?.();
    timers.run(0);
    await settle();
    expect(listener.isLive(RELAY)).toBe(false);
    pool.pageEnd = 'eose';
    timers.run(30_000);
    await settle();
    expect(listener.isLive(RELAY)).toBe(true);
  });

  it('pauses briefly again after a session that read through', async () => {
    const { pool, timers, listener } = setup(T0 + 3600);
    listener.listen(RELAY, T0);
    pool.live[0]?.params.onclose?.(['connection failed']);
    timers.run(1_000);
    pool.live[1]?.params.onclose?.(['connection failed']);
    timers.run(5_000);
    pool.live[2]?.params.oneose?.();
    timers.run(0);
    await settle();
    expect(listener.isLive(RELAY)).toBe(true);
    pool.live[2]?.params.onclose?.(['relay connection closed']);
    expect(timers.queue.map((timer) => timer.ms)).toEqual([1_000]);
  });

  it('moves the resume point only when every relay is read through', () => {
    expect(resumePointAfterSweep(true, T0 + 60, T0)).toBe(T0 + 60);
    expect(resumePointAfterSweep(false, T0 + 60, T0)).toBe(T0);
    expect(resumePointAfterSweep(false, T0 + 60, undefined)).toBeUndefined();
  });

  it('hands on each wrap once, and forgets wraps no read can reach', () => {
    const seen = new SeenWraps();
    const wrap = { id: 'a', created_at: T0 };
    expect(seen.admit(wrap)).toBe(true);
    expect(seen.admit(wrap)).toBe(false);
    seen.admit({ id: 'b', created_at: T0 + 100 });
    seen.prune(T0 + 1);
    expect(seen.size).toBe(1);
    expect(seen.admit(wrap)).toBe(true);
  });
});

describe('listen', () => {
  it('counts a relay live only after its stored wraps were read through', async () => {
    const { pool, timers, listener } = setup();
    listener.listen(RELAY, T0);
    expect(pool.live[0]?.filter).toMatchObject({ since: readSince(T0) });
    expect(listener.isLive(RELAY)).toBe(false);
    pool.live[0]?.params.oneose?.();
    timers.run(0);
    await settle();
    expect(listener.isLive(RELAY)).toBe(true);
    expect(listener.allLive([RELAY])).toBe(true);
  });

  it('retries a failed subscription from where it was asked, with a growing pause', async () => {
    const { pool, timers, listener } = setup(T0 + 3600);
    listener.listen(RELAY, T0);
    // nostr-tools calls oneose right before onclose when a subscription fails.
    pool.live[0]?.params.oneose?.();
    pool.live[0]?.params.onclose?.(['connection failed']);
    timers.run(0);
    await settle();
    expect(listener.isLive(RELAY)).toBe(false);
    expect(timers.queue.map((timer) => timer.ms)).toEqual([1_000]);
    timers.run(1_000);
    expect(pool.live[1]?.filter).toMatchObject({ since: readSince(T0) });
    pool.live[1]?.params.onclose?.(['connection failed']);
    expect(timers.queue.map((timer) => timer.ms)).toEqual([5_000]);
  });

  it('reaches back from the close once it had read through, and forgets a stale backfill', async () => {
    const { pool, timers, listener } = setup(T0 + 3600);
    listener.listen(RELAY, T0);
    pool.live[0]?.params.oneose?.();
    timers.run(0);
    await settle();
    pool.live[0]?.params.onclose?.(['relay connection closed']);
    expect(listener.isLive(RELAY)).toBe(false);
    timers.run(1_000);
    expect(pool.live[1]?.filter).toMatchObject({ since: readSince(T0 + 3600) });
    // The new subscription closes before its backfill ends: it must not count as live.
    pool.pageEnd = 'hang';
    pool.live[1]?.params.oneose?.();
    timers.run(0);
    pool.live[1]?.params.onclose?.(['relay connection closed']);
    pool.pageEnd = 'eose';
    await settle();
    expect(listener.isLive(RELAY)).toBe(false);
  });
});
