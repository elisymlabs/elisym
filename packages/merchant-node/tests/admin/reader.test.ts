import { KIND_GIFT_WRAP, type UnwrappedOrderMessage } from '@elisym/commerce';
import type { EventTemplate, Filter, NostrEvent, VerifiedEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { WRAP_PAGE_LIMIT, type WrapPool, WrapReader } from '../../src/admin/reader';
import { T0, key } from './fixtures';

const NOW = T0 + 10 * 24 * 60 * 60;
const EOSE = 'closed automatically on eose';

function wrap(id: number, createdAt: number): NostrEvent {
  return {
    id: id.toString(16).padStart(64, '0'),
    pubkey: 'f'.repeat(64),
    created_at: createdAt,
    kind: KIND_GIFT_WRAP,
    tags: [],
    content: '',
    sig: '',
  };
}

interface FakeRelay {
  wraps: NostrEvent[];
  /** Never answers. */
  silent?: boolean;
  /** Ignores `since` and `until`, as a broken relay might. */
  ignoresDates?: boolean;
}

/** Relays that answer a filter as a relay does: newest first, `limit` at most. */
function fakePool(relays: Record<string, FakeRelay>) {
  const filters: Filter[] = [];
  const auths: ((template: EventTemplate) => Promise<VerifiedEvent>)[] = [];
  const pool: WrapPool = {
    subscribeEose(urls, filter, params) {
      filters.push(filter);
      if (params.onauth !== undefined) {
        auths.push(params.onauth);
      }
      const relay = relays[urls[0] ?? ''];
      let closed = false;
      const close = (reason: string) => {
        if (!closed) {
          closed = true;
          params.onclose?.([reason]);
        }
      };
      if (relay !== undefined && relay.silent !== true) {
        queueMicrotask(() => {
          const matching = relay.wraps
            .filter(
              (event) =>
                relay.ignoresDates === true ||
                (event.created_at >= (filter.since ?? 0) &&
                  event.created_at <= (filter.until ?? Infinity)),
            )
            .sort((first, second) => second.created_at - first.created_at)
            .slice(0, filter.limit ?? Infinity);
          for (const event of matching) {
            params.onevent?.(event);
          }
          close(EOSE);
        });
      }
      return { close: (reason?: string) => close(reason ?? 'closed by caller') };
    },
  };
  return { pool, filters, auths };
}

function fakeUnwrap(calls: string[]) {
  return (event: NostrEvent): UnwrappedOrderMessage | undefined => {
    calls.push(event.id);
    return {
      rumorId: event.id,
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      createdAt: event.created_at,
      message: {
        type: 'status',
        buyerPubkey: 'a'.repeat(64),
        orderId: `order-${event.id.slice(-8)}`,
        status: 'completed',
      },
    };
  };
}

/** Timers that fire at once: a page that never answers times out on the next turn. */
function quickTimer(task: () => void): () => void {
  const handle = setTimeout(task, 1);
  return () => clearTimeout(handle);
}

function reader(
  pool: WrapPool,
  relays: string[],
  calls: string[],
  budget?: number,
  now: () => number = () => NOW,
) {
  const store = key();
  return new WrapReader({
    pool,
    relays,
    storePubkey: store.pubkey,
    auth: () => Promise.reject(new Error('not asked')),
    unwrap: fakeUnwrap(calls),
    now,
    setTimer: quickTimer,
    ...(budget === undefined ? {} : { budget }),
  });
}

describe('WrapReader', () => {
  it('pages back through every stored wrap addressed to the store', async () => {
    const wraps = Array.from({ length: WRAP_PAGE_LIMIT * 2 + 17 }, (_, index) =>
      wrap(index + 1, NOW - 1000 - index * 60),
    );
    const { pool, filters } = fakePool({ 'wss://a': { wraps } });
    const calls: string[] = [];
    const history = reader(pool, ['wss://a'], calls);
    const result = await history.load();
    expect(result).toEqual({ more: false, partial: [] });
    expect(history.messages).toHaveLength(wraps.length);
    expect(new Set(calls).size).toBe(calls.length);
    expect(filters[0]).toMatchObject({
      kinds: [KIND_GIFT_WRAP],
      until: NOW,
      limit: WRAP_PAGE_LIMIT,
    });
    expect(filters.length).toBeGreaterThan(2);
  });

  it('opens at most its budget per load, and goes on from there on the next', async () => {
    const wraps = Array.from({ length: 250 }, (_, index) => wrap(index + 1, NOW - 1000 - index));
    const { pool } = fakePool({ 'wss://a': { wraps } });
    const calls: string[] = [];
    const history = reader(pool, ['wss://a'], calls, 100);
    expect(await history.load()).toEqual({ more: true, partial: [] });
    expect(history.messages).toHaveLength(100);
    expect(await history.load()).toEqual({ more: true, partial: [] });
    expect(history.messages).toHaveLength(200);
    expect((await history.load()).more).toBe(false);
    expect(history.messages).toHaveLength(250);
    expect(calls).toHaveLength(250);
  });

  it('shares one budget across relays, and opens a wrap two relays hold once', async () => {
    const shared = Array.from({ length: 30 }, (_, index) => wrap(index + 1, NOW - 100 - index));
    const { pool } = fakePool({ 'wss://a': { wraps: shared }, 'wss://b': { wraps: shared } });
    const calls: string[] = [];
    const history = reader(pool, ['wss://a', 'wss://b'], calls);
    await history.load();
    expect(calls).toHaveLength(30);
    expect(history.messages).toHaveLength(30);
  });

  it('marks a relay that does not answer in time as partial, and reads the others', async () => {
    const { pool } = fakePool({
      'wss://a': { wraps: [wrap(1, NOW - 100)] },
      'wss://dead': { wraps: [], silent: true },
    });
    const calls: string[] = [];
    const history = reader(pool, ['wss://a', 'wss://dead'], calls);
    const result = await history.load();
    expect(result.partial).toEqual(['wss://dead']);
    expect(history.messages).toHaveLength(1);
  });

  it('answers AUTH through the given signer', async () => {
    const { pool, auths } = fakePool({ 'wss://a': { wraps: [] } });
    const store = key();
    const signer = async (template: EventTemplate) => finalizeEvent(template, store.secretKey);
    const history = new WrapReader({
      pool,
      relays: ['wss://a'],
      storePubkey: store.pubkey,
      auth: signer,
      unwrap: fakeUnwrap([]),
      now: () => NOW,
      setTimer: quickTimer,
    });
    await history.load();
    expect(auths).toEqual([signer]);
  });

  it('on refresh reads from two days before the last read, however long ago', async () => {
    const relay: FakeRelay = { wraps: [wrap(1, NOW - 100)] };
    const { pool, filters } = fakePool({ 'wss://a': relay });
    const calls: string[] = [];
    let now = NOW;
    const history = reader(pool, ['wss://a'], calls, undefined, () => now);
    await history.load();
    // Sent a day after the first load, dated 30 hours before it was sent.
    relay.wraps.push(wrap(2, NOW + 24 * 60 * 60 - 30 * 60 * 60));
    now = NOW + 2 * 24 * 60 * 60;
    await history.refresh();
    expect(calls).toEqual([wrap(1, 0).id, wrap(2, 0).id]);
    // The next refresh starts from this one.
    const firstRefresh = now;
    relay.wraps.push(wrap(3, now + 60 - 2 * 24 * 60 * 60));
    now += 120;
    await history.refresh();
    expect(filters.find((filter) => filter.until === now)?.since).toBe(
      firstRefresh - 2 * 24 * 60 * 60 - 15 * 60,
    );
    expect(calls).toEqual([wrap(1, 0).id, wrap(2, 0).id, wrap(3, 0).id]);
  });

  it('ends a range on a relay that ignores the dates asked, and reports it as partial', async () => {
    const wraps = Array.from({ length: WRAP_PAGE_LIMIT * 2 + 100 }, (_, index) =>
      wrap(index + 1, NOW - 100 - index),
    );
    const { pool, filters } = fakePool({
      'wss://a': { wraps, ignoresDates: true },
      'wss://b': { wraps: [wrap(9999, NOW - 50)] },
    });
    const calls: string[] = [];
    const history = reader(pool, ['wss://a', 'wss://b'], calls);
    expect(await history.load()).toEqual({ more: false, partial: ['wss://a'] });
    expect(filters.length).toBeLessThan(8);
    // Still partial after a refresh that reads it again.
    expect((await history.refresh()).partial).toEqual(['wss://a']);
  });

  it('refreshes the last two days and more, without opening a wrap twice', async () => {
    const relay: FakeRelay = { wraps: [wrap(1, NOW - 100)] };
    const { pool, filters } = fakePool({ 'wss://a': relay });
    const calls: string[] = [];
    let now = NOW;
    const history = reader(pool, ['wss://a'], calls, undefined, () => now);
    await history.load();
    now = NOW + 3600;
    relay.wraps.push(wrap(2, now - 2 * 24 * 60 * 60));
    const result = await history.refresh();
    expect(result.more).toBe(false);
    expect(calls).toEqual([wrap(1, 0).id, wrap(2, 0).id]);
    const refreshFilter = filters.find((filter) => filter.until === now);
    expect(refreshFilter?.since).toBe(NOW - 2 * 24 * 60 * 60 - 15 * 60);
  });
});
