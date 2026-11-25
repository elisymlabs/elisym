import { buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import type { Filter, NostrEvent } from 'nostr-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerchantConfig } from '../src/config';
import { CATCH_UP_INTERVAL_MS, WEBHOOK_TICK_MS } from '../src/constants';
import { type MerchantOrder, emptyLedger } from '../src/ledger';
import { type ListenerPool, readSince } from '../src/listener';
import type { Product } from '../src/products';
import type { PublishPool, PublishRelay } from '../src/publish';
import { type StoreNodeDeps, startStoreNode } from '../src/store-node';
import {
  D,
  T0,
  chain,
  key,
  landedPayment,
  productAt,
  referenceFor,
  requestFor,
  signatureOf,
  world,
} from './fixtures';

const RELAY = 'wss://inbox.example.com';

const CONFIG: MerchantConfig = {
  name: 'Shop',
  network: 'devnet',
  payouts: [],
  inboxRelays: [RELAY],
};

interface Subscription {
  relays: string[];
  filter: Filter;
  params: Parameters<ListenerPool['subscribe']>[2];
  closed: boolean;
}

/**
 * A pool that records live subscriptions, never answers a backfill page, and
 * publishes as `takes` says: by default the buyer's copy is taken and the
 * store's own copy refused (so the copy queue retries it later).
 */
class FakePool implements ListenerPool, PublishPool {
  live: Subscription[] = [];
  published: NostrEvent[] = [];
  /** The relay of each publish, in order. */
  publishedTo: string[] = [];
  takes: (event: NostrEvent) => boolean = () => true;
  /** Relays whose stored wraps read through at once (an empty backfill page); the others never answer. */
  readsThrough = new Set<string>();

  subscribe(relays: string[], filter: Filter, params: Subscription['params']) {
    const entry: Subscription = { relays, filter, params, closed: false };
    this.live.push(entry);
    return { close: () => (entry.closed = true) };
  }

  subscribeEose(relays: string[], _filter: Filter, params: Subscription['params']) {
    if (relays.every((relay) => this.readsThrough.has(relay))) {
      params.onclose?.(['closed automatically on eose']);
    }
    return { close: () => undefined };
  }

  ensureRelay(url: string): Promise<PublishRelay> {
    return Promise.resolve({
      publish: (event: NostrEvent) => {
        this.published.push(event);
        this.publishedTo.push(url);
        return this.takes(event)
          ? Promise.resolve('')
          : Promise.reject(new Error('blocked: rate limited'));
      },
      auth: () => Promise.resolve(''),
    });
  }
}

const STORE = key();

/** Addressed to the store itself: its own copy of a reply. */
function isSelfCopy(event: NostrEvent): boolean {
  return event.tags.some((tag) => tag[0] === 'p' && tag[1] === STORE.pubkey);
}

function paidOrder(fields: Partial<MerchantOrder> = {}): MerchantOrder {
  return {
    key: 'k',
    buyerPubkey: key().pubkey,
    orderId: 'b3a7c2d4-0000-4000-8000-00000000c001',
    rumorId: 'r',
    createdAt: T0,
    reference: 'Ref',
    product: `30402:${STORE.pubkey}:course-101`,
    reportedTxs: [],
    paid: {
      signature: signatureOf(7),
      amount: '1',
      blockTime: T0,
      caip19: 'x',
      medium: 'solana-devnet',
    },
    ...fields,
  };
}

/** Let pending promises and real I/O (signing, hashing) run; the faked timers stay put. */
/** Let pending work run for a fixed number of turns; generous so a loaded CI machine still finishes. */
async function settle() {
  for (let turn = 0; turn < 200; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Let real I/O run until `done` holds (bounded): a loaded machine may need more turns than `settle`. */
async function settleUntil(done: () => boolean) {
  for (let turn = 0; turn < 2000 && !done(); turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function setup(
  save: () => void | Promise<void> = () => undefined,
  extra: Partial<StoreNodeDeps> & { orders?: MerchantOrder[]; resumeAt?: number } = {},
) {
  const { orders = [], resumeAt, ...overrides } = extra;
  const pool = new FakePool();
  const state = emptyLedger();
  if (resumeAt !== undefined) {
    state.resumeAt = resumeAt;
  }
  for (const order of orders) {
    state.orders[order.key] = order;
  }
  const events: string[] = [];
  const logs: string[] = [];
  const started = startStoreNode({
    pool,
    config: CONFIG,
    products: new Map(),
    state,
    storePubkey: STORE.pubkey,
    storeSecretKey: STORE.secretKey,
    save: () => {
      events.push('save');
      return save();
    },
    refreshTreasuries: async () => {
      events.push('sweep');
      return { kind: 'unreachable', problem: 'offline' };
    },
    eip3009: [],
    log: (message) => logs.push(message),
    now: () => T0,
    stop: (problem) => {
      events.push(`stop:${problem}`);
    },
    ...overrides,
  });
  return { pool, state, node: await started, events, logs };
}

/** Starts that must fail: the pool and events are kept to check nothing ran. */
async function failedStart(save: () => void | Promise<void>, extra: Partial<StoreNodeDeps> = {}) {
  const pool = new FakePool();
  const start = startStoreNode({
    pool,
    config: CONFIG,
    products: new Map(),
    state: emptyLedger(),
    storePubkey: STORE.pubkey,
    storeSecretKey: STORE.secretKey,
    save,
    refreshTreasuries: async () => ({ kind: 'unreachable', problem: 'offline' }),
    eip3009: [],
    log: () => undefined,
    now: () => T0,
    stop: () => undefined,
    ...extra,
  });
  return { pool, start };
}

describe('a store node', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves where it resumes from before it listens, then sweeps', async () => {
    const { pool, state, events } = await setup();
    expect(pool.live).toHaveLength(1);
    await settle();
    expect(state.resumeAt).toBe(T0);
    expect(events.slice(0, 2)).toEqual(['save', 'sweep']);
    expect(pool.live).toHaveLength(1);
  });

  it('sweeps on its interval while it runs', async () => {
    const { events } = await setup();
    await settle();
    const sweeps = events.filter((event) => event === 'sweep').length;
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
    await settle();
    expect(events.filter((event) => event === 'sweep')).toHaveLength(sweeps + 1);
  });

  it('sweeps at once by default (the CLI), and after firstSweepDelayMs when given, then on its interval from it', async () => {
    const sweeps = (events: string[]) => events.filter((event) => event === 'sweep').length;
    const immediate = await setup();
    await settle();
    expect(sweeps(immediate.events)).toBe(1);
    await immediate.node.stop();

    const delayed = await setup(() => undefined, { firstSweepDelayMs: 25_000 });
    await settle();
    expect(sweeps(delayed.events)).toBe(0);
    vi.advanceTimersByTime(24_999);
    await settle();
    expect(sweeps(delayed.events)).toBe(0);
    vi.advanceTimersByTime(1);
    await settle();
    expect(sweeps(delayed.events)).toBe(1);
    // The interval runs from the first sweep, not from the start.
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS - 1);
    await settle();
    expect(sweeps(delayed.events)).toBe(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(sweeps(delayed.events)).toBe(2);
    await delayed.node.stop();
  });

  it('skips the save of a sweep that changed nothing when quietSweepSaveSecs is given, and saves every sweep without it (the CLI)', async () => {
    const sweepsAndSaves = (events: string[]) => ({
      sweeps: events.filter((event) => event === 'sweep').length,
      saves: events.filter((event) => event === 'save').length,
    });
    // The start's save, then the first sweep's: a sweep with no earlier sweep save always saves.
    const quiet = await setup(() => undefined, { quietSweepSaveSecs: 600 });
    await settle();
    expect(sweepsAndSaves(quiet.events)).toEqual({ sweeps: 1, saves: 2 });
    for (let interval = 0; interval < 2; interval += 1) {
      vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
      await settle();
    }
    expect(sweepsAndSaves(quiet.events)).toEqual({ sweeps: 3, saves: 2 });
    await quiet.node.stop();

    const every = await setup();
    await settle();
    for (let interval = 0; interval < 2; interval += 1) {
      vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
      await settle();
    }
    expect(sweepsAndSaves(every.events)).toEqual({ sweeps: 3, saves: 4 });
    await every.node.stop();
  });

  it('stopped before its delayed first sweep, it never sweeps and leaves no timer', async () => {
    const { node, events } = await setup(() => undefined, { firstSweepDelayMs: 25_000 });
    await settle();
    await node.stop();
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS * 2);
    await settle();
    expect(events.filter((event) => event === 'sweep')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('once stopped, takes no task, closes its subscriptions and ends its timers', async () => {
    const { pool, node, events } = await setup();
    await settle();
    await node.stop();
    const before = events.length;
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS * 3);
    await settle();
    expect(events).toHaveLength(before);
    expect(pool.live.every((subscription) => subscription.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves stop only once the task in progress has saved', async () => {
    let finishSave: () => void = () => undefined;
    let saves = 0;
    const { node } = await setup(() => {
      saves += 1;
      // The first save (where it resumes from) is done; the sweep's is held.
      if (saves === 1) {
        return undefined;
      }
      return new Promise<void>((resolve) => {
        finishSave = resolve;
      });
    });
    await settle();
    expect(saves).toBe(2);
    let stopped = false;
    void node.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    finishSave();
    await settle();
    expect(stopped).toBe(true);
  });

  it('refuses to start, listening to nothing, when the first save fails', async () => {
    await expect(
      setup(() => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
  });

  it('refuses to start, leaving no timer, when the first save rejects later', async () => {
    const { pool, start } = await failedStart(async () => {
      await Promise.resolve();
      throw new Error('lease lost');
    });
    await expect(start).rejects.toThrow('lease lost');
    await settle();
    expect(pool.live).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a webhook URL it cannot parse before it listens', async () => {
    const saves: string[] = [];
    const { pool, start } = await failedStart(
      () => {
        saves.push('save');
      },
      { webhook: { target: { url: 'not a url', secret: 's'.repeat(32) }, userAgent: 'test' } },
    );
    await expect(start).rejects.toThrow();
    expect(saves).toEqual([]);
    expect(pool.live).toHaveLength(0);
  });

  it('resumes from an earlier point it saved, never from a later one', async () => {
    const earlier = await setup(undefined, { resumeAt: T0 - 100 });
    expect(earlier.state.resumeAt).toBe(T0 - 100);
    expect(earlier.pool.live[0]?.filter.since).toBe(readSince(T0 - 100));
    await earlier.node.stop();
    const later = await setup(undefined, { resumeAt: T0 + 100 });
    expect(later.state.resumeAt).toBe(T0);
    expect(later.pool.live[0]?.filter.since).toBe(readSince(T0));
  });

  it('moves its resume point only once the listen-only relays read through too', async () => {
    const OLD = 'wss://old-inbox.example.com';
    let clock = T0;
    const { pool, state, node } = await setup(undefined, {
      extraListenRelays: [OLD],
      now: () => clock,
    });
    pool.readsThrough.add(RELAY);
    for (const subscription of pool.live) {
      subscription.params.oneose?.();
    }
    vi.advanceTimersByTime(0);
    await settle();
    clock = T0 + 100;
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
    await settle();
    // The inbox relay read through; the old one did not: a restart must read it from T0.
    expect(state.resumeAt).toBe(T0);
    pool.readsThrough.add(OLD);
    pool.live.find((subscription) => subscription.relays.includes(OLD))?.params.oneose?.();
    vi.advanceTimersByTime(0);
    await settle();
    clock = T0 + 200;
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
    await settle();
    expect(state.resumeAt).toBe(T0 + 200);
    await node.stop();
  });

  it('drops a task queued before stop that had not started', async () => {
    let finishSave: () => void = () => undefined;
    let saves = 0;
    const { node, events } = await setup(() => {
      saves += 1;
      if (saves === 2) {
        return new Promise<void>((resolve) => {
          finishSave = resolve;
        });
      }
      return undefined;
    });
    await settle();
    // The first sweep is held in its save; the next one waits behind it.
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
    const stopping = node.stop();
    finishSave();
    await stopping;
    await settle();
    expect(events.filter((event) => event === 'sweep')).toHaveLength(1);
  });

  it('halts for good on a failed save when the host asks, and says why', async () => {
    let saves = 0;
    const { pool, events } = await setup(
      () => {
        saves += 1;
        if (saves === 2) {
          throw new Error('lease lost');
        }
      },
      { haltOnSaveFailure: true },
    );
    await settle();
    expect(events).toContain('stop:the ledger could not be saved: lease lost');
    expect(pool.live.every((subscription) => subscription.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS * 3);
    await settle();
    expect(events.filter((event) => event === 'sweep')).toHaveLength(1);
  });

  it('publishes the store copy only after the save, and ends its retry timer at stop', async () => {
    let finishSave: () => void = () => undefined;
    let saves = 0;
    const { pool, node, state } = await setup(
      () => {
        saves += 1;
        // The first is where it resumes from, the second the sweep's, the third the delivery's.
        if (saves === 3) {
          return new Promise<void>((resolve) => {
            finishSave = resolve;
          });
        }
        return undefined;
      },
      { orders: [paidOrder()] },
    );
    pool.takes = (event) => !isSelfCopy(event);
    await settle();
    // Delivered to the buyer; the save that records it is still being written.
    expect(state.orders.k?.deliveredAt).toBe(T0);
    expect(pool.published.filter(isSelfCopy)).toHaveLength(0);
    finishSave();
    await settle();
    expect(pool.published.filter(isSelfCopy)).toHaveLength(1);
    // The copy was refused: a retry waits on a timer, ended by stop.
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    await node.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends a due webhook on its tick and saves the outcome', async () => {
    const sent: string[] = [];
    const { events, state } = await setup(undefined, {
      orders: [
        paidOrder({
          deliveredAt: T0,
          webhook: {
            state: 'pending',
            eventId: 'evt_1',
            createdAt: T0,
            deadline: T0 + 3600,
            attempts: 0,
            nextAt: T0 + 30,
          },
        }),
      ],
      webhook: {
        target: { url: 'https://hooks.example.com/paid', secret: 's'.repeat(32) },
        userAgent: 'test',
        fetch: async (url) => {
          sent.push(url);
          events.push('fetch');
          return new Response(null, { status: 200 });
        },
      },
      now: () => T0 + 60,
    });
    await settleUntil(() => sent.length > 0);
    expect(sent).toEqual(['https://hooks.example.com/paid']);
    await settleUntil(() => state.orders.k?.webhook?.state === 'sent');
    expect(state.orders.k?.webhook?.state).toBe('sent');
    expect(events.at(-1)).toBe('save');
    expect(events.indexOf('fetch')).toBeLessThan(events.lastIndexOf('save'));
  });

  it('halts on a failed save of a webhook outcome when the host asks', async () => {
    let fetched = false;
    const { events } = await setup(
      () => {
        if (fetched) {
          throw new Error('lease lost');
        }
      },
      {
        haltOnSaveFailure: true,
        orders: [
          paidOrder({
            deliveredAt: T0,
            webhook: {
              state: 'pending',
              eventId: 'evt_1',
              createdAt: T0,
              deadline: T0 + 3600,
              attempts: 0,
              nextAt: T0,
            },
          }),
        ],
        webhook: {
          target: { url: 'https://hooks.example.com/paid', secret: 's'.repeat(32) },
          userAgent: 'test',
          fetch: async () => {
            fetched = true;
            return new Response(null, { status: 200 });
          },
        },
      },
    );
    await settleUntil(() => events.includes('stop:the ledger could not be saved: lease lost'));
    expect(fetched).toBe(true);
    expect(events).toContain('stop:the ledger could not be saved: lease lost');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one sweep waiting at most, however many intervals pass', async () => {
    let finishSave: () => void = () => undefined;
    let saves = 0;
    const { events, node } = await setup(() => {
      saves += 1;
      if (saves === 2) {
        return new Promise<void>((resolve) => {
          finishSave = resolve;
        });
      }
      return undefined;
    });
    await settle();
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS * 3);
    finishSave();
    await settle();
    expect(events.filter((event) => event === 'sweep')).toHaveLength(2);
    await node.stop();
  });

  it('does not report a save failing after the host stopped it', async () => {
    let failSave: (error: Error) => void = () => undefined;
    let saves = 0;
    const { events, node } = await setup(
      () => {
        saves += 1;
        if (saves === 2) {
          return new Promise<void>((_resolve, reject) => {
            failSave = reject;
          });
        }
        return undefined;
      },
      { haltOnSaveFailure: true },
    );
    await settle();
    const stopping = node.stop();
    failSave(new Error('lease lost'));
    await stopping;
    expect(events.some((event) => event.startsWith('stop:'))).toBe(false);
  });

  it('picks webhooks again on its interval', async () => {
    let clock = T0;
    const sent: string[] = [];
    await setup(undefined, {
      orders: [
        paidOrder({
          deliveredAt: T0,
          webhook: {
            state: 'pending',
            eventId: 'evt_1',
            createdAt: T0,
            deadline: T0 + 3600,
            attempts: 0,
            nextAt: T0 + 5,
          },
        }),
      ],
      webhook: {
        target: { url: 'https://hooks.example.com/paid', secret: 's'.repeat(32) },
        userAgent: 'test',
        fetch: async (url) => {
          sent.push(url);
          return new Response(null, { status: 200 });
        },
      },
      now: () => clock,
    });
    await settle();
    expect(sent).toEqual([]);
    clock = T0 + 10;
    vi.advanceTimersByTime(WEBHOOK_TICK_MS);
    await settleUntil(() => sent.length > 0);
    expect(sent).toHaveLength(1);
  });

  it('logs a task whose save fails, and keeps taking tasks', async () => {
    let saves = 0;
    const { events, logs } = await setup(() => {
      saves += 1;
      if (saves === 2) {
        throw new Error('disk full');
      }
    });
    await settle();
    expect(logs).toContain('error: disk full');
    const sweeps = events.filter((event) => event === 'sweep').length;
    vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
    await settle();
    expect(events.filter((event) => event === 'sweep')).toHaveLength(sweeps + 1);
  });
});

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000c001';
const SIG = signatureOf(7);
const PRODUCT: Product = {
  d: D,
  title: 'Course',
  description: 'A course.',
  priceUsd: '1',
  onSale: true,
  file: `products/${D}/PRODUCT.md`,
};

interface ShopOptions {
  /** The chain's transactions, given the reference of this buyer's order. */
  transactions?: (reference: string) => Promise<Record<string, unknown>>;
  save?: (state: string) => void | Promise<void>;
  extra?: Partial<StoreNodeDeps>;
}

/** A store over a fake Solana chain, fed wraps by hand on its live subscription. */
async function shop(options: ShopOptions = {}) {
  const setup = world();
  const buyer = key();
  const pool = new FakePool();
  const events: string[] = [];
  const reference = referenceFor(setup.store, buyer, ORDER_ID);
  const { rpc } = chain((await options.transactions?.(reference)) ?? {});
  const save = options.save ?? (() => undefined);
  const node = await startStoreNode({
    pool,
    config: { ...CONFIG, rpcUrl: 'https://rpc.example.com' },
    products: new Map([[D, PRODUCT]]),
    state: setup.state,
    storePubkey: setup.store.pubkey,
    storeSecretKey: setup.store.secretKey,
    solanaRpc: rpc,
    save: () => save(JSON.stringify(setup.state)),
    refreshTreasuries: async () => ({ kind: 'unreachable', problem: 'offline' }),
    eip3009: [],
    outbox: { storePubkey: setup.store.pubkey, now: () => T0 + 500 },
    log: () => undefined,
    // Real time: wraps are dated by NIP-59 from the real clock.
    now: () => Math.floor(Date.now() / 1000),
    stop: (problem) => {
      events.push(`stop:${problem}`);
    },
    ...options.extra,
  });
  const wrap = (message: Parameters<typeof buildOrderMessage>[0]) =>
    wrapOrderMessage(buildOrderMessage(message, T0 + 60), buyer.secretKey, setup.store.pubkey)
      .recipientWrap;
  const order = wrap({
    type: 'order',
    storePubkey: setup.store.pubkey,
    orderId: ORDER_ID,
    items: [{ product: productAt(setup.store), quantity: 1 }],
    total: { amount: '1', currency: 'USD' },
  });
  const receipt = wrap({
    type: 'receipt',
    storePubkey: setup.store.pubkey,
    orderId: ORDER_ID,
    payment: { medium: 'solana-devnet', reference, tx: SIG },
  });
  const send = (event: NostrEvent, relay = RELAY) => {
    pool.live.find((subscription) => subscription.relays.includes(relay))?.params.onevent(event);
  };
  return {
    ...setup,
    pool,
    node,
    events,
    order,
    receipt,
    send,
    orderKey: `${buyer.pubkey}:${ORDER_ID}`,
  };
}

describe('a store node end to end', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes an order and its paid receipt, saves the payment with its webhook, and completes it', async () => {
    const snapshots: string[] = [];
    const store = await shop({
      transactions: async (reference) => ({ [SIG]: await landedPayment(requestFor(reference)) }),
      save: (state) => {
        snapshots.push(state);
      },
    });
    await settle();
    store.send(store.order);
    store.send(store.order);
    // Each wrap is taken once.
    expect(store.node.runtime.seenWraps.size).toBe(1);
    store.send(store.receipt);
    await settleUntil(() => store.state.orders[store.orderKey]?.deliveredAt !== undefined);
    const order = store.state.orders[store.orderKey];
    expect(order?.paid?.signature).toBe(SIG);
    expect(order?.webhook?.state).toBe('pending');
    expect(order?.deliveredAt).toBeDefined();
    const withPayment = snapshots
      .map((text) => JSON.parse(text) as typeof store.state)
      .filter((snapshot) => snapshot.orders[store.orderKey]?.paid !== undefined);
    expect(withPayment.length).toBeGreaterThan(0);
    for (const snapshot of withPayment) {
      expect(snapshot.orders[store.orderKey]?.webhook?.state).toBe('pending');
    }
    await store.node.stop();
  });

  it('takes an order sent to a listen-only relay and replies on the inbox relays only', async () => {
    const OLD = 'wss://old-inbox.example.com';
    const store = await shop({
      transactions: async (reference) => ({ [SIG]: await landedPayment(requestFor(reference)) }),
      extra: { extraListenRelays: [OLD, RELAY] },
    });
    await settle();
    expect(store.pool.live.map((subscription) => subscription.relays)).toEqual([[RELAY], [OLD]]);
    store.send(store.order, OLD);
    store.send(store.receipt, OLD);
    await settleUntil(
      () =>
        store.state.orders[store.orderKey]?.deliveredAt !== undefined &&
        store.pool.publishedTo.length > 0,
    );
    expect(store.state.orders[store.orderKey]?.deliveredAt).toBeDefined();
    expect(store.pool.publishedTo.length).toBeGreaterThan(0);
    expect(new Set(store.pool.publishedTo)).toEqual(new Set([RELAY]));
    await store.node.stop();
    expect(store.pool.live.every((subscription) => subscription.closed)).toBe(true);
  });

  it('hands on a wrap read twice (live and backfill) only once', async () => {
    let saves = 0;
    const store = await shop({
      transactions: async (reference) => ({ [SIG]: await landedPayment(requestFor(reference)) }),
      save: () => {
        saves += 1;
      },
    });
    await settle();
    store.send(store.order);
    store.send(store.receipt);
    await settleUntil(() => store.state.orders[store.orderKey]?.deliveredAt !== undefined);
    expect(store.state.orders[store.orderKey]?.deliveredAt).toBeDefined();
    const published = store.pool.published.length;
    const saved = saves;
    // Read again: a receipt of a delivered order would be saved and its status sent again.
    store.send(store.receipt);
    await settle();
    expect(saves).toBe(saved);
    expect(store.pool.published).toHaveLength(published);
    await store.node.stop();
  });

  it('asks the chain again later for a receipt it does not show yet', async () => {
    const store = await shop();
    await settle();
    const timers = vi.getTimerCount();
    store.send(store.order);
    store.send(store.receipt);
    await settleUntil(() => vi.getTimerCount() === timers + 1);
    expect(vi.getTimerCount()).toBe(timers + 1);
    await store.node.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules nothing once stopped, even from the task in progress', async () => {
    let finishSave: () => void = () => undefined;
    let holding = false;
    const store = await shop({
      // No transaction on the chain yet: the check is asked again later.
      save: (state) => {
        if (!holding && state.includes(SIG)) {
          holding = true;
          return new Promise<void>((resolve) => {
            finishSave = resolve;
          });
        }
        return undefined;
      },
    });
    await settle();
    store.send(store.order);
    await settle();
    store.send(store.receipt);
    await settleUntil(() => holding);
    // The receipt's save is held; the node is stopped meanwhile.
    expect(holding).toBe(true);
    const stopping = store.node.stop();
    finishSave();
    await stopping;
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});
