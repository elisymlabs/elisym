import {
  KIND_GIFT_WRAP,
  KIND_INBOX_RELAYS,
  KIND_PRODUCT,
  type UnwrappedOrderMessage,
  buildProductEvent,
  buildStoreProfileEvent,
} from '@elisym/commerce';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { MAX_UNWRAPS_PER_LOAD, type WrapPool } from '../../src/admin/reader';
import {
  AdminSession,
  type Outcome,
  type SessionDeps,
  type Snapshot,
} from '../../src/admin/session';
import { MAX_SUBSCRIPTIONS_PER_RELAY } from '../../src/constants';
import {
  D,
  T0,
  USDC_DEVNET_CAIP19,
  type Key,
  key,
  message,
  orderBody,
  productOf,
} from './fixtures';

const INBOX = 'wss://relay.example.com';
const SOL_MAINNET_USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function listing(store: Key, d: string, createdAt = T0 - 60, accept = [USDC_DEVNET_CAIP19]) {
  return finalizeEvent(
    buildProductEvent({
      d,
      title: `Product ${d}`,
      description: '',
      price: { amount: '1', currency: 'USD' },
      accept,
      createdAt,
    }),
    store.secretKey,
  );
}

function storeEvents(store: Key, owner: Key, relays = [INBOX]): NostrEvent[] {
  return [
    finalizeEvent(
      buildStoreProfileEvent({ name: 'Shop', ownerPubkey: owner.pubkey, createdAt: T0 }),
      store.secretKey,
    ),
    finalizeEvent(
      {
        kind: KIND_INBOX_RELAYS,
        created_at: T0,
        tags: relays.map((relay) => ['relay', relay]),
        content: '',
      },
      store.secretKey,
    ),
  ];
}

function matches(event: NostrEvent, filter: Filter): boolean {
  return (
    (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
    (filter.authors === undefined || filter.authors.includes(event.pubkey)) &&
    (filter.until === undefined || event.created_at <= filter.until) &&
    (filter['#d'] === undefined ||
      event.tags.some((tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] ?? '') === true))
  );
}

interface RelayOptions {
  /** Events per relay; a relay not named holds `events`. */
  byRelay?: Record<string, NostrEvent[]>;
  /** A relay's own result cap per filter. */
  cap?: number;
  /** Relays that ignore `until`. */
  ignoreUntil?: string[];
  /** Answer after this many ms (a macrotask), so overlapping reads really overlap. */
  delayMs?: (filter: Filter) => number;
}

interface FakeClient extends RelayClient {
  /** Every filter asked, with its relays. */
  asked: { relays: string[]; filter: Filter }[];
  /** The most subscriptions ever open at once on one relay. */
  peak: () => number;
  /** Queries not answered yet. */
  inFlight: () => number;
}

/** A relay client answering as relays would: newest first, `until`, `limit` and a cap per filter. */
function relayClient(events: NostrEvent[], options: RelayOptions = {}): FakeClient {
  const open = new Map<string, number>();
  let peak = 0;
  let pending = 0;
  const asked: FakeClient['asked'] = [];
  const answer = (relay: string, filter: Filter): NostrEvent[] => {
    const held = options.byRelay?.[relay] ?? events;
    const effective = options.ignoreUntil?.includes(relay)
      ? { ...filter, until: undefined }
      : filter;
    const limit = Math.min(filter.limit ?? 500, options.cap ?? 500);
    return held
      .filter((event) => matches(event, effective))
      .sort(
        (first, second) => second.created_at - first.created_at || (first.id < second.id ? -1 : 1),
      )
      .slice(0, limit);
  };
  return {
    asked,
    peak: () => peak,
    inFlight: () => pending,
    async query(relays, filters) {
      for (const filter of filters) {
        asked.push({ relays: [...relays], filter });
      }
      for (const relay of relays) {
        const count = (open.get(relay) ?? 0) + filters.length;
        open.set(relay, count);
        peak = Math.max(peak, count);
      }
      pending += 1;
      const delay = Math.max(0, ...filters.map((filter) => options.delayMs?.(filter) ?? 0));
      await new Promise((resolve) => setTimeout(resolve, delay));
      pending -= 1;
      for (const relay of relays) {
        open.set(relay, (open.get(relay) ?? 0) - filters.length);
      }
      const seen = new Set<string>();
      return relays
        .flatMap((relay) => filters.flatMap((filter) => answer(relay, filter)))
        .filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)));
    },
    publish: () => Promise.resolve({ accepted: [], failed: [] }),
    subscribe: () => ({ close: () => undefined }),
    close: () => undefined,
  };
}

/** Wraps that `unwrap` turns into the given messages, without any crypto. */
function wrapsOf(messages: UnwrappedOrderMessage[]): {
  wraps: NostrEvent[];
  unwrap: SessionDeps['unwrap'];
} {
  const byId = new Map<string, UnwrappedOrderMessage>();
  const wraps = messages.map((unwrapped, index) => {
    const id = (index + 1).toString(16).padStart(64, '0');
    byId.set(id, unwrapped);
    return {
      id,
      kind: KIND_GIFT_WRAP,
      pubkey: '00'.repeat(32),
      created_at: unwrapped.createdAt,
      tags: [],
      content: '',
      sig: '00'.repeat(64),
    };
  });
  return { wraps, unwrap: (wrap) => byId.get(wrap.id) };
}

interface FakePool extends WrapPool {
  relaysAsked: string[];
  /** Hold every page until `release()`. */
  release: () => void;
}

function fakePool(wraps: NostrEvent[], options: { hold?: boolean } = {}): FakePool {
  const held: (() => void)[] = [];
  let released = !options.hold;
  const relaysAsked: string[] = [];
  return {
    relaysAsked,
    release() {
      released = true;
      for (const task of held.splice(0)) {
        task();
      }
    },
    subscribeEose(relays, filter, params) {
      relaysAsked.push(...relays);
      const answer = () => {
        for (const wrap of wraps) {
          if (wrap.created_at >= (filter.since ?? 0) && wrap.created_at <= (filter.until ?? 0)) {
            params.onevent?.(wrap);
          }
        }
        params.onclose?.(['closed automatically on eose']);
      };
      if (released) {
        queueMicrotask(answer);
      } else {
        held.push(answer);
      }
      return { close: () => undefined };
    },
  };
}

function orderMessages(store: Key, ds: string[]): UnwrappedOrderMessage[] {
  return ds.map((d, index) => {
    const buyer = key();
    return message(
      orderBody(store, `b3a7c2d4-0000-4000-8000-${index.toString().padStart(12, '0')}`, {
        items: [{ product: productOf(store, d), quantity: 1 }],
      }),
      buyer.pubkey,
      store.pubkey,
    );
  });
}

function session(
  deps: SessionDeps,
  store: Key,
  readAllListings: boolean,
  statuses: string[] = [],
  stores: string[] = [],
) {
  return new AdminSession(
    deps,
    { secretKey: new Uint8Array(store.secretKey), pubkey: store.pubkey },
    { readAllListings },
    (text) => statuses.push(text),
    (view) => stores.push(view.name ?? ''),
  );
}

function snapshotOf(outcome: Outcome): Snapshot {
  if (outcome === 'busy' || !outcome.ok) {
    throw new Error(`no snapshot: ${JSON.stringify(outcome)}`);
  }
  return outcome.snapshot;
}

const now = () => T0 + 600;

/** More listings in one second than a page holds. */
const WALL_SIZE = 300;
// Heavy on Schnorr: hundreds of signatures signed and checked, slow on a busy CI runner.
const WALL_TIMEOUT_MS = 90_000;
let sharedWall: { store: Key; owner: Key; wall: NostrEvent[] } | undefined;

/** A store whose listings form a same-second wall: signed once, shared by the tests that need one. */
function wallStore(): { store: Key; owner: Key; wall: NostrEvent[] } {
  if (sharedWall === undefined) {
    const store = key();
    const wall = Array.from({ length: WALL_SIZE }, (_, index) =>
      listing(store, `w-${index}`, T0 - 100),
    );
    sharedWall = { store, owner: key(), wall };
  }
  return sharedWall;
}

describe('AdminSession', () => {
  it('opens: status texts in order, the store before the orders, the final status last', async () => {
    const store = key();
    const owner = key();
    const { wraps, unwrap } = wrapsOf(orderMessages(store, [D]));
    const pool = fakePool(wraps, { hold: true });
    const statuses: string[] = [];
    const stores: string[] = [];
    const client = relayClient([...storeEvents(store, owner), listing(store, D)]);
    /** Reads still running when the final status fired: none, the snapshot is complete. */
    let pendingAtRead: number | undefined;
    const admin = new AdminSession(
      { client, pool, now, unwrap },
      { secretKey: new Uint8Array(store.secretKey), pubkey: store.pubkey },
      { readAllListings: false },
      (text) => {
        statuses.push(text);
        if (text.startsWith('Read ')) {
          pendingAtRead = client.inFlight();
        }
      },
      (view) => stores.push(view.name ?? ''),
    );
    let resolved = false;
    const opening = admin.open().then((outcome) => {
      resolved = true;
      return outcome;
    });
    await vi.waitFor(() => expect(statuses).toContain('Reading orders...'));
    expect(stores).toEqual(['Shop']);
    expect(resolved).toBe(false);
    pool.release();
    const outcome = await opening;
    expect(pendingAtRead).toBe(0);
    expect(statuses).toEqual([
      'Reading the store...',
      'Reading orders...',
      'Read 1 order messages from 1 relays.',
    ]);
    const snapshot = snapshotOf(outcome);
    expect(snapshot.history.rows).toHaveLength(1);
    expect(snapshot.products.map((product) => product.d)).toEqual([D]);
    expect(snapshot.allProducts).toBeUndefined();
    expect(snapshot.store.relays).toEqual([INBOX]);
  });

  it('answers busy while a call runs, including open', async () => {
    const store = key();
    const pool = fakePool([], { hold: true });
    const admin = session(
      { client: relayClient(storeEvents(store, key())), pool, now },
      store,
      false,
    );
    const first = admin.open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await admin.open()).toBe('busy');
    expect(await admin.refresh()).toBe('busy');
    expect(await admin.more()).toBe('busy');
    pool.release();
    expect(snapshotOf(await first).history.rows).toEqual([]);
  });

  it('reports a failure as a status and no snapshot, and Refresh then opens', async () => {
    const store = key();
    const healthy = relayClient(storeEvents(store, key()));
    let failing = true;
    const client: RelayClient = {
      ...healthy,
      query: (relays, filters, options) =>
        failing ? Promise.reject(new Error('relay down')) : healthy.query(relays, filters, options),
    };
    const statuses: string[] = [];
    const admin = session({ client, pool: fakePool([]), now }, store, false, statuses);
    expect(await admin.open()).toEqual({ ok: false });
    expect(statuses.at(-1)).toBe('Could not read: relay down');
    failing = false;
    expect(snapshotOf(await admin.refresh()).store.name).toBe('Shop');
    expect(statuses.at(-1)).toMatch(/^Read 0 order messages/);
  });

  it('more before a successful open opens', async () => {
    const store = key();
    const admin = session(
      { client: relayClient(storeEvents(store, key())), pool: fakePool([]), now },
      store,
      false,
    );
    expect(snapshotOf(await admin.more()).store.relays).toEqual([INBOX]);
  });

  it('close zeroes the key and refuses every later call', async () => {
    const store = key();
    const secretKey = new Uint8Array(store.secretKey);
    const admin = new AdminSession(
      { client: relayClient(storeEvents(store, key())), pool: fakePool([]), now },
      { secretKey, pubkey: store.pubkey },
      { readAllListings: false },
      () => undefined,
      () => undefined,
    );
    admin.close();
    expect(secretKey.every((byte) => byte === 0)).toBe(true);
    expect(await admin.open()).toBe('busy');
    expect(await admin.refresh()).toBe('busy');
  });

  it('reads with a new reader when the inbox relays change, and keeps the old view when the store does not answer', async () => {
    const store = key();
    const owner = key();
    let events = storeEvents(store, owner);
    const healthy = relayClient([]);
    const client: RelayClient = {
      ...healthy,
      query: (relays, filters, options) => relayClient(events).query(relays, filters, options),
    };
    const pool = fakePool([]);
    const admin = session({ client, pool, now }, store, false);
    await admin.open();
    expect(pool.relaysAsked).toEqual([INBOX]);

    events = storeEvents(store, owner, ['wss://other.example.com']);
    const moved = snapshotOf(await admin.refresh());
    expect(moved.store.relays).toEqual(['wss://other.example.com']);
    expect(pool.relaysAsked.at(-1)).toBe('wss://other.example.com');

    events = [];
    const stale = snapshotOf(await admin.refresh());
    expect(stale.store.relays).toEqual(['wss://other.example.com']);
    expect(stale.warnings.join(' ')).toMatch(/did not answer for the store/);

    // The store answers again: the warning goes.
    events = storeEvents(store, owner, ['wss://other.example.com']);
    const answered = snapshotOf(await admin.refresh());
    expect(answered.warnings.join(' ')).not.toMatch(/did not answer for the store/);
  });

  it('reads with a new reader when the inbox list shrinks', async () => {
    const store = key();
    const owner = key();
    const second = 'wss://second.example.com';
    let events = storeEvents(store, owner, [INBOX, second]);
    const client: RelayClient = {
      ...relayClient([]),
      query: (relays, filters, options) => relayClient(events).query(relays, filters, options),
    };
    const pool = fakePool([]);
    const admin = session({ client, pool, now }, store, false);
    await admin.open();
    expect([...pool.relaysAsked].sort()).toEqual([INBOX, second].sort());

    events = storeEvents(store, owner, [INBOX]);
    pool.relaysAsked.length = 0;
    await admin.refresh();
    expect(pool.relaysAsked).toEqual([INBOX]);
  });

  it('counts hidden orders against the listings orders name, not every listing', async () => {
    const store = key();
    const owner = key();
    const { wraps, unwrap } = wrapsOf(orderMessages(store, ['wide-only']));
    const answering = relayClient([...storeEvents(store, owner), listing(store, 'wide-only')]);
    // The relays answer the store-wide read but not the read by product id.
    const client: RelayClient = {
      ...answering,
      query: (relays, filters, options) =>
        filters.some((filter) => filter['#d'] !== undefined)
          ? Promise.resolve([])
          : answering.query(relays, filters, options),
    };
    const snapshot = snapshotOf(
      await session({ client, pool: fakePool(wraps), now, unwrap }, store, true).open(),
    );
    expect(snapshot.history.rows).toEqual([]);
    expect(snapshot.warnings.join(' ')).toMatch(/1 orders name products with no listing found/);
    expect(snapshot.allProducts?.lines.map((line) => line.d)).toEqual(['wide-only']);
  });

  it('without readAllListings asks no store-wide listing query', async () => {
    const store = key();
    const { wraps, unwrap } = wrapsOf(orderMessages(store, [D]));
    const client = relayClient([...storeEvents(store, key()), listing(store, D)]);
    const admin = session({ client, pool: fakePool(wraps), now, unwrap }, store, false);
    await admin.open();
    await admin.refresh();
    const storeWide = client.asked.filter(
      ({ filter }) => filter.kinds?.includes(KIND_PRODUCT) === true && filter['#d'] === undefined,
    );
    expect(storeWide).toEqual([]);
  });

  it('all listings never change the history, and list every product', async () => {
    const store = key();
    const owner = key();
    const { wraps, unwrap } = wrapsOf(orderMessages(store, [D]));
    const base = [...storeEvents(store, owner), listing(store, D)];
    const extra = [
      listing(store, 'other-1', T0 - 30, [SOL_MAINNET_USDC]),
      listing(store, 'other-2', T0 - 20, [SOL_MAINNET_USDC]),
    ];
    const read = async (events: NostrEvent[], readAll: boolean) =>
      snapshotOf(
        await session(
          { client: relayClient(events), pool: fakePool(wraps), now, unwrap },
          store,
          readAll,
        ).open(),
      );
    const without = await read(base, false);
    const withExtra = await read([...base, ...extra], true);
    expect(withExtra.history).toEqual(without.history);
    expect(withExtra.products).toEqual(without.products);
    expect(withExtra.allProducts?.lines.map((line) => line.d)).toEqual([D, 'other-1', 'other-2']);
    expect(withExtra.allProducts?.incomplete).toBe(false);
  });

  it('pages each relay, and unions relays with different windows', async () => {
    const store = key();
    const owner = key();
    const many = Array.from({ length: 400 }, (_, index) =>
      listing(store, `p-${index.toString().padStart(3, '0')}`, T0 - 1000 + index),
    );
    const other = 'wss://second.example.com';
    const client = relayClient([], {
      byRelay: {
        // The inbox holds the newest 300, the second relay the oldest 260: each more than a page.
        [INBOX]: many.slice(100),
        [other]: many.slice(0, 260),
        'wss://relay.damus.io': storeEvents(store, owner, [INBOX, other]),
        'wss://nos.lol': storeEvents(store, owner, [INBOX, other]),
      },
    });
    const admin = session({ client, pool: fakePool([]), now }, store, true);
    const snapshot = snapshotOf(await admin.open());
    expect(snapshot.allProducts?.lines).toHaveLength(400);
    expect(snapshot.allProducts?.incomplete).toBe(false);
    const storeWide = client.asked.filter(
      ({ filter }) => filter.kinds?.includes(KIND_PRODUCT) === true && filter['#d'] === undefined,
    );
    expect(storeWide.length).toBeGreaterThan(2);
    expect(storeWide.every(({ relays }) => relays.length === 1)).toBe(true);
  });

  it('pages a relay that caps below the page size to the end, and stops at the page cap', async () => {
    const store = key();
    const owner = key();
    // Signed once: each case reads the newest `count` of them.
    const signed = Array.from({ length: 172 }, (_, index) =>
      listing(store, `c-${index}`, T0 - 5000 + index),
    );
    const spread = (count: number) => signed.slice(signed.length - count);
    const read = async (count: number) =>
      snapshotOf(
        await session(
          {
            client: relayClient([...storeEvents(store, owner), ...spread(count)], { cap: 20 }),
            pool: fakePool([]),
            now,
          },
          store,
          true,
        ).open(),
      );
    // Exactly eight full pages (the first brings 20, each next one 19 new: `until` is
    // inclusive): the probe page finds nothing new, so the list is whole.
    const exact = await read(153);
    expect(exact.allProducts?.lines).toHaveLength(153);
    expect(exact.allProducts?.incomplete).toBe(false);
    const capped = await read(60);
    expect(capped.allProducts?.lines).toHaveLength(60);
    expect(capped.allProducts?.incomplete).toBe(false);
    // Exactly nine full pages: the ninth still brings new listings, one page past the
    // eight read, so the list is incomplete and holds the eight pages only.
    const long = await read(172);
    expect(long.allProducts?.incomplete).toBe(true);
    expect(long.allProducts?.lines).toHaveLength(153);
  });

  it(
    'a Refresh that reads the whole list clears incomplete',
    { timeout: WALL_TIMEOUT_MS },
    async () => {
      const { store, owner, wall } = wallStore();
      let events = [...storeEvents(store, owner), ...wall];
      const client: RelayClient = {
        ...relayClient([]),
        query: (relays, filters, options) => relayClient(events).query(relays, filters, options),
      };
      const admin = session({ client, pool: fakePool([]), now }, store, true);
      expect(snapshotOf(await admin.open()).allProducts?.incomplete).toBe(true);
      events = [...storeEvents(store, owner), ...wall.slice(0, 20)];
      expect(snapshotOf(await admin.refresh()).allProducts?.incomplete).toBe(false);
    },
  );

  it('tells the store on Refresh before the wraps are read', async () => {
    const store = key();
    const stores: string[] = [];
    const pool = fakePool([]);
    const admin = session(
      { client: relayClient(storeEvents(store, key())), pool, now },
      store,
      false,
      [],
      stores,
    );
    await admin.open();
    const held = fakePool([], { hold: true });
    pool.subscribeEose = held.subscribeEose;
    const refreshing = admin.refresh();
    await vi.waitFor(() => expect(stores).toEqual(['Shop', 'Shop']), { timeout: 10_000 });
    held.release();
    await refreshing;
  });

  it(
    'calls the list incomplete at a same-second wall and at a relay ignoring until',
    { timeout: WALL_TIMEOUT_MS },
    async () => {
      const { store, owner, wall } = wallStore();
      const wallSnapshot = snapshotOf(
        await session(
          { client: relayClient([...storeEvents(store, owner), ...wall]), pool: fakePool([]), now },
          store,
          true,
        ).open(),
      );
      expect(wallSnapshot.allProducts?.incomplete).toBe(true);

      const spread = Array.from({ length: 300 }, (_, index) =>
        listing(store, `s-${index}`, T0 - 1000 + index),
      );
      const ignoring = snapshotOf(
        await session(
          {
            client: relayClient([...storeEvents(store, owner), ...spread], {
              ignoreUntil: [INBOX],
            }),
            pool: fakePool([]),
            now,
          },
          store,
          true,
        ).open(),
      );
      expect(ignoring.allProducts?.incomplete).toBe(true);

      const few = Array.from({ length: 30 }, (_, index) => listing(store, `f-${index}`, T0 - 100));
      const complete = snapshotOf(
        await session(
          { client: relayClient([...storeEvents(store, owner), ...few]), pool: fakePool([]), now },
          store,
          true,
        ).open(),
      );
      expect(complete.allProducts?.incomplete).toBe(false);
      expect(complete.allProducts?.lines).toHaveLength(30);
    },
  );

  it('keeps a product seen on open when a relay does not answer on Refresh', async () => {
    const store = key();
    const owner = key();
    const { wraps, unwrap } = wrapsOf(orderMessages(store, [D]));
    let events = [...storeEvents(store, owner), listing(store, D), listing(store, 'extra')];
    const client: RelayClient = {
      ...relayClient([]),
      query: (relays, filters, options) => relayClient(events).query(relays, filters, options),
    };
    const admin = session({ client, pool: fakePool(wraps), now, unwrap }, store, true);
    const opened = snapshotOf(await admin.open());
    expect(opened.allProducts?.lines.map((line) => line.d)).toEqual([D, 'extra']);

    events = storeEvents(store, owner);
    const refreshed = snapshotOf(await admin.refresh());
    expect(refreshed.allProducts?.lines.map((line) => line.d)).toEqual([D, 'extra']);
  });

  it('a failed wraps read still waits for the all-listings read before giving up', async () => {
    const store = key();
    const owner = key();
    const client = relayClient([...storeEvents(store, owner), listing(store, D)], {
      delayMs: (filter) =>
        filter.kinds?.includes(KIND_PRODUCT) === true && filter['#d'] === undefined ? 40 : 0,
    });
    const pool: WrapPool = {
      subscribeEose() {
        throw new Error('pool broke');
      },
    };
    const statuses: string[] = [];
    const admin = session({ client, pool, now }, store, true, statuses);
    expect(await admin.open()).toEqual({ ok: false });
    expect(client.inFlight()).toBe(0);
    expect(statuses.at(-1)).toBe('Could not read: pool broke');
  });

  it('a Refresh on the same relays keeps the history more() loaded', async () => {
    const store = key();
    const owner = key();
    const ds = [...Array.from({ length: MAX_UNWRAPS_PER_LOAD }, () => D), D];
    const { wraps, unwrap } = wrapsOf(orderMessages(store, ds));
    const admin = session(
      {
        client: relayClient([...storeEvents(store, owner), listing(store, D)]),
        pool: fakePool(wraps),
        now,
        unwrap,
      },
      store,
      false,
    );
    expect(snapshotOf(await admin.open()).history.rows).toHaveLength(MAX_UNWRAPS_PER_LOAD);
    expect(snapshotOf(await admin.more()).history.rows).toHaveLength(MAX_UNWRAPS_PER_LOAD + 1);
    expect(snapshotOf(await admin.refresh()).history.rows).toHaveLength(MAX_UNWRAPS_PER_LOAD + 1);
  });

  it("a relay's forged copy of a listing never hides another relay's genuine one", async () => {
    const store = key();
    const owner = key();
    const genuine = listing(store, 'real');
    const second = 'wss://second.example.com';
    // Copies a relay could tamper with, each keeping the genuine id.
    const forgeries: NostrEvent[] = [
      { ...genuine, sig: 'f'.repeat(128) },
      { ...genuine, content: 'tampered' },
      { ...genuine, created_at: genuine.created_at + 1 },
      { ...genuine, tags: [...genuine.tags, ['t', 'tampered']] },
    ];
    // Each forgery read first, and read last.
    const pairs = forgeries.flatMap((forged) => [
      [forged, genuine],
      [genuine, forged],
    ]);
    for (const [first, last] of pairs) {
      const client = relayClient([], {
        byRelay: {
          'wss://relay.damus.io': storeEvents(store, owner, [INBOX, second]),
          'wss://nos.lol': storeEvents(store, owner, [INBOX, second]),
          [INBOX]: first === undefined ? [] : [first],
          [second]: last === undefined ? [] : [last],
        },
      });
      const snapshot = snapshotOf(
        await session({ client, pool: fakePool([]), now }, store, true).open(),
      );
      expect(snapshot.allProducts?.lines.map((line) => line.d)).toEqual(['real']);
    }
  });

  it('a failed all-listings read fails the run', async () => {
    const store = key();
    const owner = key();
    const answering = relayClient([...storeEvents(store, owner), listing(store, D)]);
    const client: RelayClient = {
      ...answering,
      query: (relays, filters, options) =>
        filters.some(
          (filter) => filter.kinds?.includes(KIND_PRODUCT) === true && filter['#d'] === undefined,
        )
          ? Promise.reject(new Error('listings down'))
          : answering.query(relays, filters, options),
    };
    const statuses: string[] = [];
    const admin = session({ client, pool: fakePool([]), now }, store, true, statuses);
    expect(await admin.open()).toEqual({ ok: false });
    expect(statuses.at(-1)).toBe('Could not read: listings down');
  });

  it('reads all listings from the default relays too, not only the inbox', async () => {
    const store = key();
    const owner = key();
    const onDefaultOnly = listing(store, 'default-only');
    const client = relayClient([], {
      byRelay: {
        'wss://relay.damus.io': [...storeEvents(store, owner), onDefaultOnly],
        'wss://nos.lol': storeEvents(store, owner),
        [INBOX]: [],
      },
    });
    const snapshot = snapshotOf(
      await session({ client, pool: fakePool([]), now }, store, true).open(),
    );
    expect(snapshot.allProducts?.lines.map((line) => line.d)).toEqual(['default-only']);
  });

  it('adds the products of orders more() loads, with no store-wide read', async () => {
    const store = key();
    const owner = key();
    // One load opens at most MAX_UNWRAPS_PER_LOAD wraps: the last order waits for more().
    const ds = [...Array.from({ length: MAX_UNWRAPS_PER_LOAD }, () => D), 'late'];
    const { wraps, unwrap } = wrapsOf(orderMessages(store, ds));
    const answering = relayClient([
      ...storeEvents(store, owner),
      listing(store, D),
      listing(store, 'late'),
    ]);
    const storeWide: Filter[] = [];
    // Store-wide reads come back empty: the list only grows from the claim-check listings.
    const client: FakeClient = {
      ...answering,
      query: (relays, filters, options) => {
        const wide = filters.filter(
          (filter) => filter.kinds?.includes(KIND_PRODUCT) === true && filter['#d'] === undefined,
        );
        storeWide.push(...wide);
        return wide.length > 0 ? Promise.resolve([]) : answering.query(relays, filters, options);
      },
    };
    const admin = session({ client, pool: fakePool(wraps), now, unwrap }, store, true);
    const opened = snapshotOf(await admin.open());
    expect(opened.more).toBe(true);
    expect(opened.allProducts?.lines.map((line) => line.d)).toEqual([D]);
    const wideBefore = storeWide.length;
    expect(wideBefore).toBeGreaterThan(0);
    const more = snapshotOf(await admin.more());
    expect(more.allProducts?.lines.map((line) => line.d)).toEqual([D, 'late']);
    expect(storeWide).toHaveLength(wideBefore);
  });

  it(
    'never holds more subscriptions on one relay than the budget, on open and on Refresh',
    { timeout: 30_000 },
    async () => {
      const store = key();
      const owner = key();
      const ds = Array.from({ length: 151 }, (_, index) => `n-${index}`);
      const { wraps, unwrap } = wrapsOf(orderMessages(store, ds));
      const pool = fakePool(wraps, { hold: true });
      const client = relayClient(
        [...storeEvents(store, owner), ...ds.map((d) => listing(store, d))],
        {
          // The all-listings pages answer late: past the wraps load, into the claim-check read.
          delayMs: (filter) =>
            filter['#d'] === undefined && filter.kinds?.includes(KIND_PRODUCT) ? 40 : 5,
        },
      );
      const admin = session({ client, pool, now, unwrap }, store, true);
      const opening = admin.open();
      await new Promise((resolve) => setTimeout(resolve, 10));
      pool.release();
      expect(snapshotOf(await opening).allProducts?.lines).toHaveLength(151);
      expect(client.peak()).toBeLessThanOrEqual(MAX_SUBSCRIPTIONS_PER_RELAY);
      expect(snapshotOf(await admin.refresh()).history.rows).toHaveLength(151);
      expect(client.peak()).toBeLessThanOrEqual(MAX_SUBSCRIPTIONS_PER_RELAY);
    },
  );
});
