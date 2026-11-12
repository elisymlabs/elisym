import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  buildCatalogAuth,
  buildCatalogItemEvent,
  buildConfigEvent,
  unwrapChatMessage,
} from '@elisym/askr';
import {
  type LlmProvider,
  type TurnRequest,
  type TurnResponse,
  type Usage,
  costOf,
} from '@elisym/askr-agent';
import { KIND_DELETION, buildStoreAuthEvent } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUBSCRIPTION_BUDGET } from '../src/constants';
import type { Db } from '../src/db/db';
import { passesWrapPreCheck } from '../src/relay/pool';
import { PgState } from '../src/state/pg-state';
import type { LeasedStore, StoreStatus } from '../src/state/types';
import { Worker } from '../src/worker/worker';
import { FakePool } from './fake-pool';
import {
  HOLDER,
  NOW,
  ORIGIN,
  type StoreSpec,
  type SyntheticStore,
  askWrap,
  scriptedProvider,
  seedHistory,
  stateWith,
  storeRecord,
  syntheticStore,
} from './fixtures';

const RELAY = 'wss://relay.test';
const PRICE = { input: '1', cachedInput: '0.1', cacheWrite: '1.25', output: '5' };
const SMALL_USAGE: Usage = {
  inputTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 20,
};

const running: Worker[] = [];

afterEach(() => {
  for (const worker of running.splice(0)) {
    worker.stop();
  }
});

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error('condition not reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A provider whose every turn waits until the test releases it. */
function heldProvider(): LlmProvider & { requests: TurnRequest[]; release: () => void } {
  const requests: TurnRequest[] = [];
  const waiting: (() => void)[] = [];
  return {
    model: 'held',
    requests,
    release: () => {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
    async turn(request: TurnRequest): Promise<TurnResponse> {
      requests.push(request);
      await new Promise<void>((resolve) => waiting.push(resolve));
      return { text: 'Here.', toolCalls: [], stopReason: 'end_turn', usage: SMALL_USAGE };
    },
  };
}

class CountingState extends PgState {
  leaseCalls = 0;
  sweepCalls = 0;
  /** The last sweep the timer started, so a test can wait for it. */
  lastSweep: Promise<void> = Promise.resolve();
  override sweep(now: number): Promise<void> {
    this.sweepCalls += 1;
    this.lastSweep = super.sweep(now);
    return this.lastSweep;
  }
  /** Delays of the next `rumorSeen` calls, in order, so a test can slow one intake down. */
  rumorSeenDelaysMs: number[] = [];
  override async rumorSeen(rumorId: string, now: number): Promise<boolean> {
    const delay = this.rumorSeenDelaysMs.shift();
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return super.rumorSeen(rumorId, now);
  }
  /** When set, lease reads wait for it before they reach the database. */
  leaseGate: Promise<void> | undefined;
  leaseGateEntered = false;
  override async acquireLeases(
    holder: string,
    now: number,
    ttlSecs: number,
  ): Promise<LeasedStore[]> {
    this.leaseCalls += 1;
    if (this.leaseGate !== undefined) {
      this.leaseGateEntered = true;
      await this.leaseGate;
    }
    return super.acquireLeases(holder, now, ttlSecs);
  }
  /** When set, the answer's step fails as a database error would. */
  answerFails = false;
  override answerAsk(...args: Parameters<PgState['answerAsk']>): Promise<boolean> {
    if (this.answerFails) {
      return Promise.reject(new Error('connection lost'));
    }
    return super.answerAsk(...args);
  }
}

interface Harness {
  db: Db;
  pool: FakePool;
  state: CountingState;
  worker: Worker;
  gatewaySecret: Uint8Array;
  logs: string[];
  clock: { now: number };
}

async function harness(input: {
  stores: SyntheticStore[];
  provider?: LlmProvider;
  records?: StoreSpec[];
  reserveUsd?: string;
  historyTimeoutMs?: number;
  extraRelayBudgetMs?: number;
  stableConnectionMs?: number;
  configurePool?: (pool: FakePool) => void;
  /** Leave the worker unstarted (the test starts it). */
  idle?: boolean;
}): Promise<Harness> {
  const clock = { now: NOW };
  let worker: Worker | undefined;
  const pool = new FakePool((event) =>
    passesWrapPreCheck(event, (pubkey) => worker?.isLeased(pubkey) ?? false, clock.now),
  );
  input.configurePool?.(pool);
  for (const store of input.stores) {
    for (const event of store.events) {
      pool.relay(RELAY).accept(event);
    }
  }
  const seeded = await stateWith(input.records ?? input.stores.map((store) => storeRecord(store)));
  const { db } = seeded;
  const state = new CountingState(db, seeded.vault);
  const gatewaySecret = generateSecretKey();
  const logs: string[] = [];
  const provider = input.provider ?? scriptedProvider(['Here.']);
  worker = new Worker({
    relayUrl: RELAY,
    state,
    pool,
    gatewayKeys: [getPublicKey(gatewaySecret)],
    providerFor: () => provider,
    price: PRICE,
    holder: HOLDER,
    reserveUsd: input.reserveUsd ?? '0.25',
    now: () => clock.now,
    log: (message) => logs.push(message),
    ...(input.historyTimeoutMs === undefined ? {} : { historyTimeoutMs: input.historyTimeoutMs }),
    ...(input.extraRelayBudgetMs === undefined
      ? {}
      : { extraRelayBudgetMs: input.extraRelayBudgetMs, extraRelayTimeoutMs: 1_000 }),
    ...(input.stableConnectionMs === undefined
      ? {}
      : { stableConnectionMs: input.stableConnectionMs }),
  });
  running.push(worker);
  if (!input.idle) {
    await worker.start();
  }
  return { db, pool, state, worker, gatewaySecret, logs, clock };
}

function ask(setup: Harness, store: SyntheticStore, visitorSecret: Uint8Array, askId: string) {
  setup.pool.relay(RELAY).accept(
    askWrap({
      store,
      visitorSecret,
      gatewaySecret: setup.gatewaySecret,
      askId,
      text: 'something warm?',
      now: setup.clock.now,
    }),
  );
}

/** What the visitor received from A, in publish order. */
function received(setup: Harness, store: SyntheticStore, visitorSecret: Uint8Array) {
  return setup.pool.published.flatMap((wrap) => {
    const opened = unwrapChatMessage(wrap, visitorSecret);
    return opened && opened.senderPubkey === store.assistant ? [{ wrap, ...opened }] : [];
  });
}

function day(setup: Harness, store: SyntheticStore) {
  return setup.state.dayTotals(store.owner, setup.clock.now);
}

/** An operator changing a store's state in the database (7.3). */
async function setStatus(setup: Harness, store: SyntheticStore, status: StoreStatus) {
  await setup.db.query('update stores set status = $2 where owner = $1', [store.owner, status]);
}

describe('worker turns (5.8)', () => {
  it('answers an ask and settles the reservation to the actual spend', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a1'.repeat(16));
    await waitUntil(() => received(setup, store, visitorSecret).length > 0);
    await setup.worker.idle();
    const [answer] = received(setup, store, visitorSecret);
    expect(answer?.message).toMatchObject({ type: 'answer', ask_id: 'a1'.repeat(16) });
    expect(await day(setup, store)).toEqual({
      spent: costOf(SMALL_USAGE, PRICE).toString(),
      reserved: '0',
    });
  });

  it('re-publishes the stored answer for a repeated ask id, with no new turn', async () => {
    const store = syntheticStore();
    const provider = scriptedProvider(['Here.']);
    const setup = await harness({ stores: [store], provider });
    const visitorSecret = generateSecretKey();
    const askId = 'a2'.repeat(16);
    ask(setup, store, visitorSecret, askId);
    await waitUntil(() => received(setup, store, visitorSecret).length === 1);
    await setup.worker.idle();
    ask(setup, store, visitorSecret, askId);
    await waitUntil(() => received(setup, store, visitorSecret).length === 2);
    await setup.worker.idle();
    const [first, second] = received(setup, store, visitorSecret);
    expect(second?.wrap.id).toBe(first?.wrap.id);
    expect(provider.requests).toHaveLength(1);
  });

  it('does not re-run an ask that is still running, and runs one turn at a time per session', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a3'.repeat(16));
    await waitUntil(() => provider.requests.length === 1);
    ask(setup, store, visitorSecret, 'a3'.repeat(16));
    ask(setup, store, visitorSecret, 'b3'.repeat(16));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.requests).toHaveLength(1);
    provider.release();
    await waitUntil(() => provider.requests.length === 2);
    provider.release();
    await setup.worker.idle();
    // The repeated a3 waited behind the running turn, then got the stored answer again (same wrap).
    const answers = received(setup, store, visitorSecret).filter(
      (opened) => opened.message.type === 'answer',
    );
    expect(answers.map((opened) => opened.message.ask_id)).toEqual([
      'a3'.repeat(16),
      'a3'.repeat(16),
      'b3'.repeat(16),
    ]);
    expect(answers[1]?.wrap.id).toBe(answers[0]?.wrap.id);
    expect(provider.requests).toHaveLength(2);
  });

  it('a turn that fails mid-way settles what it spent and tells the visitor error', async () => {
    const store = syntheticStore();
    const heavy: Usage = { ...SMALL_USAGE, inputTokens: 300_000 };
    const provider: LlmProvider & { calls: number } = {
      model: 'tool-then-ceiling',
      calls: 0,
      async turn(): Promise<TurnResponse> {
        provider.calls += 1;
        return {
          text: '',
          toolCalls: [
            { type: 'tool_use', id: 'tool-1', name: 'search_products', input: { query: 'warm' } },
          ],
          stopReason: 'tool_use',
          usage: heavy,
        };
      },
    };
    const setup = await harness({ stores: [store], provider, reserveUsd: '0.25' });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a4'.repeat(16));
    await waitUntil(() => received(setup, store, visitorSecret).length > 0);
    await setup.worker.idle();
    // The first call cost 0.3 USD, past the 0.25 ceiling, so no second call was made.
    expect(provider.calls).toBe(1);
    const messages = received(setup, store, visitorSecret).map((opened) => opened.message);
    expect(messages).toContainEqual({
      type: 'unavailable',
      ask_id: 'a4'.repeat(16),
      reason: 'error',
    });
    expect(await day(setup, store)).toEqual({
      spent: costOf(heavy, PRICE).toString(),
      reserved: '0',
    });
  });

  it('an answer that comes past the deadline is not sent; its spend is kept and the visitor gets error', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a5'.repeat(16));
    await waitUntil(() => provider.requests.length === 1);
    setup.clock.now += 3 * 60;
    provider.release();
    await setup.worker.idle();
    const messages = received(setup, store, visitorSecret).map((opened) => opened.message);
    expect(messages.some((message) => message.type === 'answer')).toBe(false);
    expect(messages).toContainEqual({
      type: 'unavailable',
      ask_id: 'a5'.repeat(16),
      reason: 'error',
    });
    expect(await day(setup, store)).toEqual({
      spent: costOf(SMALL_USAGE, PRICE).toString(),
      reserved: '0',
    });
  });

  it('a second worker on the same state leaves a turn that is still running alone', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    const second = new Worker({
      relayUrl: RELAY,
      state: setup.state,
      pool: setup.pool,
      gatewayKeys: [getPublicKey(setup.gatewaySecret)],
      providerFor: () => provider,
      price: PRICE,
      // The same holder: the lease (and its epoch) carries over, as on a restart within the TTL.
      holder: HOLDER,
      reserveUsd: '0.25',
      now: () => setup.clock.now,
    });
    running.push(second);
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a7'.repeat(16));
    await waitUntil(() => provider.requests.length === 1);
    setup.worker.stop();
    await second.start();
    ask(setup, store, visitorSecret, 'a7'.repeat(16));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await second.idle();
    expect(provider.requests).toHaveLength(1);
    provider.release();
  });

  it('keeps a bounded history per session', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const visitorSecret = generateSecretKey();
    for (let index = 0; index < 12; index += 1) {
      ask(setup, store, visitorSecret, index.toString(16).padStart(32, 'c'));
      await waitUntil(() => received(setup, store, visitorSecret).length === index + 1);
      await setup.worker.idle();
    }
    const session = await setup.state.session(
      store.owner,
      store.assistant,
      getPublicKey(visitorSecret),
      NOW,
    );
    expect(session.history.length).toBeGreaterThan(0);
    expect(session.history.length).toBeLessThanOrEqual(20);
  });
});

describe('worker wraps (2.4)', () => {
  it('reads leases from a set, not by deriving keys per wrap', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const before = setup.state.leaseCalls;
    for (let index = 0; index < 100; index += 1) {
      setup.worker.isLeased(store.assistant);
    }
    expect(setup.worker.isLeased(store.assistant)).toBe(true);
    expect(setup.worker.isLeased(getPublicKey(generateSecretKey()))).toBe(false);
    expect(setup.state.leaseCalls).toBe(before);
  });

  it('a resubscription skips wraps already verified', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a6'.repeat(16));
    await waitUntil(() => received(setup, store, visitorSecret).length === 1);
    const first = setup.pool.relay(RELAY);
    const wrapIds = first.events.filter((event) => event.kind === 1059).map((event) => event.id);
    first.drop();
    await waitUntil(() =>
      setup.pool
        .relay(RELAY)
        .open.some((subscription) => subscription.filters.some((filter) => filter['#p'])),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replayed = setup.pool.relay(RELAY).delivered;
    expect(wrapIds.some((id) => replayed.includes(id))).toBe(false);
  });

  it('batches every leased A into one wrap REQ and stays within the subscription budget', async () => {
    const stores = Array.from({ length: 40 }, () => syntheticStore());
    const setup = await harness({ stores });
    const relay = setup.pool.relay(RELAY);
    await waitUntil(() =>
      relay.open.some((subscription) => subscription.filters.some((filter) => filter['#p'])),
    );
    const wrapRequests = relay.open.filter((subscription) =>
      subscription.filters.some((filter) => filter.kinds?.includes(1059)),
    );
    expect(wrapRequests).toHaveLength(1);
    expect(wrapRequests[0]?.filters[0]?.['#p']).toHaveLength(40);
    expect(relay.open.length).toBeLessThanOrEqual(SUBSCRIPTION_BUDGET);
    expect(setup.worker.catalogs.size).toBe(40);
  });

  it('a store that stops being active is no longer leased, and its catalog is dropped', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    expect(setup.worker.catalogs.has(store.owner)).toBe(true);
    await setStatus(setup, store, 'suspended');
    await setup.worker.refreshLeases();
    expect(setup.worker.isLeased(store.assistant)).toBe(false);
    expect(setup.worker.catalogs.has(store.owner)).toBe(false);
  });
});

function listing(secret: Uint8Array, d: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    buildCatalogItemEvent({
      d,
      title: `Item ${d}`,
      description: 'A thing.',
      price: { amount: '10', currency: 'USD' },
      url: `${ORIGIN}/products/${d}`,
      createdAt,
    }),
    secret,
  );
}

function ownerReloads(setup: Harness, store: SyntheticStore): number {
  return setup.pool
    .relay(RELAY)
    .requests.filter((filters) =>
      filters.some(
        (filter) => filter.kinds?.includes(KIND_CONFIG) && filter.authors?.includes(store.owner),
      ),
    ).length;
}

describe('worker catalogs (5.1, 2.4)', () => {
  it('coalesces a burst of catalog events into at most one more reload, one REQ at a time', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    const before = ownerReloads(setup, store);
    for (let index = 0; index < 20; index += 1) {
      relay.accept(listing(store.catalogSecret, `burst-${index}`, NOW - 10));
    }
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 22);
    await setup.worker.catalogsSettled();
    expect(ownerReloads(setup, store) - before).toBeLessThanOrEqual(2);
    // The wrap REQ and one reload page at most.
    expect(relay.maxOpenHistory).toBeLessThanOrEqual(2);
  });

  it('pages a large catalog without losing events that share the page boundary second', async () => {
    const store = syntheticStore();
    // Three listings per second, aligned so the 500-event page boundary (after the 2 newer listings) falls inside one second.
    const many = Array.from({ length: 600 }, (_, index) =>
      listing(store.catalogSecret, `many-${index}`, NOW - 1_000 + Math.floor((index + 1) / 3)),
    );
    const setup = await harness({ stores: [{ ...store, events: [...store.events, ...many] }] });
    expect(setup.worker.catalogs.get(store.owner)?.items.size).toBe(602);
  });

  it('a failed reload keeps the old cache and retries after the backoff', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    relay.closeOn = (filters) => filters.some((filter) => filter.kinds?.includes(KIND_CONFIG));
    relay.accept(listing(store.catalogSecret, 'late', NOW - 10));
    await waitUntil(() => ownerReloads(setup, store) >= 2);
    expect(setup.worker.catalogs.get(store.owner)?.items.size).toBe(2);
    relay.closeOn = undefined;
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 3, 4_000);
  });

  it('re-issues the live REQ when the config names a new catalog key', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    const nextSecret = generateSecretKey();
    const nextKey = getPublicKey(nextSecret);
    relay.accept(
      finalizeEvent(
        buildCatalogAuth({ key: nextKey, mode: 'hosted', createdAt: NOW - 20 }),
        store.ownerSecret,
      ),
    );
    relay.accept(
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: store.assistant,
            origins: [ORIGIN],
            name: 'Example Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: nextKey,
            createdAt: NOW - 20,
          },
          store.ownerSecret,
        ),
        store.ownerSecret,
      ),
    );
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.config.catalogKey === nextKey);
    await setup.worker.catalogsSettled();
    relay.accept(listing(nextSecret, 'from-new-key', NOW - 10));
    await waitUntil(() =>
      Boolean(setup.worker.catalogs.get(store.owner)?.items.has('from-new-key')),
    );
  });

  it('a deleted config leaves the store with no catalog', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    setup.pool.relay(RELAY).accept(
      finalizeEvent(
        {
          kind: KIND_DELETION,
          created_at: NOW - 10,
          content: '',
          tags: [['a', `${KIND_CONFIG}:${store.owner}:${CONFIG_D_TAG}`]],
        },
        store.ownerSecret,
      ),
    );
    await waitUntil(() => !setup.worker.catalogs.has(store.owner));
  });

  it('a Pay Core source reads the store key authority (30490) from the default relays too', async () => {
    const ownerSecret = generateSecretKey();
    const assistantSecret = generateSecretKey();
    const storeSecret = generateSecretKey();
    const policySecret = generateSecretKey();
    const owner = getPublicKey(ownerSecret);
    const storeKey = getPublicKey(storeSecret);
    const policyKey = getPublicKey(policySecret);
    const config = finalizeEvent(
      buildConfigEvent(
        {
          assistant: getPublicKey(assistantSecret),
          origins: [ORIGIN],
          name: 'Pay Core Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'paycore' },
          catalogKey: storeKey,
          policyKey,
          createdAt: NOW - 100,
        },
        ownerSecret,
      ),
      ownerSecret,
    );
    const store: SyntheticStore = {
      ownerSecret,
      owner,
      assistantSecret,
      assistant: getPublicKey(assistantSecret),
      catalogSecret: storeSecret,
      catalogKey: storeKey,
      events: [config, listing(storeSecret, 'paycore-item', NOW - 50)],
    };
    const storeAuth = finalizeEvent(
      buildStoreAuthEvent({ storePubkey: storeKey, mode: 'hosted', createdAt: NOW - 100 }),
      ownerSecret,
    );
    const setup = await harness({ stores: [store] });
    expect(setup.worker.catalogs.get(owner)?.items.size).toBe(0);
    setup.pool.relay('wss://nos.lol').accept(storeAuth);
    // Any owner event queues a full reload, which reads the default relays again.
    setup.pool
      .relay(RELAY)
      .accept(
        finalizeEvent(
          buildCatalogAuth({ key: policyKey, mode: 'hosted', createdAt: NOW - 90 }),
          ownerSecret,
        ),
      );
    await waitUntil(() => setup.worker.catalogs.get(owner)?.items.size === 1);
  });
});

/** A store on keys given by the test: its config names `catalogSecret`'s key and, when given, a separate policy key. */
function storeOnKeys(input: {
  catalogSecret: Uint8Array;
  policySecret?: Uint8Array;
  listings?: NostrEvent[];
}): SyntheticStore {
  const ownerSecret = generateSecretKey();
  const assistantSecret = generateSecretKey();
  const catalogKey = getPublicKey(input.catalogSecret);
  const policyKey = input.policySecret ? getPublicKey(input.policySecret) : undefined;
  const config = finalizeEvent(
    buildConfigEvent(
      {
        assistant: getPublicKey(assistantSecret),
        origins: [ORIGIN],
        name: 'Second Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey,
        ...(policyKey === undefined ? {} : { policyKey }),
        createdAt: NOW - 100,
      },
      ownerSecret,
    ),
    ownerSecret,
  );
  const auths = [catalogKey, ...(policyKey === undefined ? [] : [policyKey])].map((key) =>
    finalizeEvent(buildCatalogAuth({ key, mode: 'hosted', createdAt: NOW - 100 }), ownerSecret),
  );
  return {
    ownerSecret,
    owner: getPublicKey(ownerSecret),
    assistantSecret,
    assistant: getPublicKey(assistantSecret),
    catalogSecret: input.catalogSecret,
    catalogKey,
    events: [config, ...auths, ...(input.listings ?? [])],
  };
}

function liveRequests(setup: Harness) {
  return setup.pool
    .relay(RELAY)
    .open.filter((subscription) => subscription.filters.some((filter) => filter.limit === 0));
}

function wrapRequests(setup: Harness) {
  return setup.pool
    .relay(RELAY)
    .open.filter((subscription) =>
      subscription.filters.some((filter) => filter.kinds?.includes(1059)),
    );
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('worker review round 2', () => {
  it('a key two stores share reloads both of them', async () => {
    const first = syntheticStore();
    const second = storeOnKeys({ catalogSecret: first.catalogSecret });
    // Each row keeps its own server K (unique in the database); the configs name the shared key.
    const ownKey = generateSecretKey();
    const setup = await harness({
      stores: [first, second],
      records: [
        storeRecord(first),
        storeRecord({ ...second, catalogSecret: ownKey, catalogKey: getPublicKey(ownKey) }),
      ],
    });
    expect(setup.worker.catalogs.get(second.owner)?.items.size).toBe(2);
    setup.pool.relay(RELAY).accept(listing(first.catalogSecret, 'shared', NOW - 10));
    await waitUntil(
      () =>
        setup.worker.catalogs.get(first.owner)?.items.size === 3 &&
        setup.worker.catalogs.get(second.owner)?.items.size === 3,
    );
  });

  it('watches a catalog key apart from the policy key', async () => {
    const catalogSecret = generateSecretKey();
    const store = storeOnKeys({ catalogSecret, policySecret: generateSecretKey() });
    const setup = await harness({ stores: [store] });
    setup.pool.relay(RELAY).accept(listing(catalogSecret, 'apart', NOW - 10));
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 1);
  });

  it('after a dropped connection: one live and one wrap REQ come back, and every store reloads in full', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const old = setup.pool.relay(RELAY);
    old.drop();
    // Published while the worker was away: only a full reload sees it.
    const fresh = setup.pool.relay(RELAY);
    fresh.events.push(listing(store.catalogSecret, 'missed', NOW - 10));
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 3, 4_000);
    await waitUntil(() => liveRequests(setup).length === 1 && wrapRequests(setup).length === 1);
    await pause(2_500);
    expect(liveRequests(setup)).toHaveLength(1);
    expect(wrapRequests(setup)).toHaveLength(1);
    expect(fresh.requests.filter((filters) => filters[0]?.limit === 0)).toHaveLength(1);
  });

  it('a re-issue closes the old REQs without starting a reconnect', async () => {
    const store = syntheticStore();
    const later = syntheticStore();
    const setup = await harness({
      stores: [store, later],
      records: [storeRecord(store), storeRecord(later, 'pending')],
    });
    const relay = setup.pool.relay(RELAY);
    await setStatus(setup, later, 'active');
    await setup.worker.refreshLeases();
    await waitUntil(() => setup.worker.catalogs.has(later.owner));
    await waitUntil(() =>
      wrapRequests(setup).some((subscription) => subscription.filters[0]?.['#p']?.length === 2),
    );
    const reloads = ownerReloads(setup, store);
    await pause(2_500);
    expect(wrapRequests(setup)).toHaveLength(1);
    expect(liveRequests(setup)).toHaveLength(1);
    expect(ownerReloads(setup, store)).toBe(reloads);
    expect(relay).toBe(setup.pool.relay(RELAY));
    // The newly leased store answers.
    const visitorSecret = generateSecretKey();
    ask(setup, later, visitorSecret, 'a8'.repeat(16));
    await waitUntil(() => received(setup, later, visitorSecret).length === 1);
  });

  it('a wrap REQ with no real EOSE is closed and reopened after the backoff', async () => {
    const store = syntheticStore();
    const setup = await harness({
      stores: [store],
      historyTimeoutMs: 100,
      configurePool: (pool) => {
        pool.relay(RELAY).holdEose = (filters) =>
          filters.some((filter) => filter.kinds?.includes(1059));
      },
    });
    const opened = () =>
      setup.pool
        .relay(RELAY)
        .requests.filter((filters) => filters.some((filter) => filter.kinds?.includes(1059)))
        .length;
    await waitUntil(() => opened() >= 2, 4_000);
    expect(wrapRequests(setup).length).toBeLessThanOrEqual(1);
  });

  it('a page whose connection died after its EOSE does not count: the reload runs again', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const old = setup.pool.relay(RELAY);
    old.disconnectAfterEose = (filters) =>
      filters.some((filter) => filter.kinds?.includes(KIND_CONFIG));
    old.accept(listing(store.catalogSecret, 'after-drop', NOW - 10));
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 3, 4_000);
    const fresh = setup.pool.relay(RELAY);
    expect(fresh).not.toBe(old);
    expect(
      fresh.requests.filter((filters) =>
        filters.some((filter) => filter.kinds?.includes(KIND_CONFIG)),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('a Pay Core store loads while one default relay is unreachable', async () => {
    const ownerSecret = generateSecretKey();
    const storeSecret = generateSecretKey();
    const assistantSecret = generateSecretKey();
    const policyKey = getPublicKey(generateSecretKey());
    const storeKey = getPublicKey(storeSecret);
    const config = finalizeEvent(
      buildConfigEvent(
        {
          assistant: getPublicKey(assistantSecret),
          origins: [ORIGIN],
          name: 'Pay Core Shop',
          language: 'en',
          currency: 'USD',
          source: { kind: 'paycore' },
          catalogKey: storeKey,
          policyKey,
          createdAt: NOW - 100,
        },
        ownerSecret,
      ),
      ownerSecret,
    );
    const store: SyntheticStore = {
      ownerSecret,
      owner: getPublicKey(ownerSecret),
      assistantSecret,
      assistant: getPublicKey(assistantSecret),
      catalogSecret: storeSecret,
      catalogKey: storeKey,
      events: [config, listing(storeSecret, 'paycore-item', NOW - 50)],
    };
    const setup = await harness({
      stores: [store],
      configurePool: (pool) => {
        pool.unreachable.add('wss://relay.damus.io');
        pool
          .relay('wss://nos.lol')
          .accept(
            finalizeEvent(
              buildStoreAuthEvent({ storePubkey: storeKey, mode: 'hosted', createdAt: NOW - 100 }),
              ownerSecret,
            ),
          );
      },
    });
    expect(setup.worker.catalogs.get(store.owner)?.items.size).toBe(1);
  });

  it('events during a pending retry wait for it instead of reloading at once', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    relay.closeOn = (filters) => filters.some((filter) => filter.kinds?.includes(KIND_CONFIG));
    const before = ownerReloads(setup, store);
    relay.accept(listing(store.catalogSecret, 'retry-0', NOW - 10));
    await waitUntil(() => ownerReloads(setup, store) === before + 1);
    for (let index = 1; index < 6; index += 1) {
      relay.accept(listing(store.catalogSecret, `retry-${index}`, NOW - 10));
    }
    await pause(100);
    expect(ownerReloads(setup, store)).toBe(before + 1);
  });

  it('a worker stopped while starting opens nothing', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store], idle: true });
    const started = setup.worker.start();
    setup.worker.stop();
    await started;
    await pause(50);
    expect(setup.pool.relay(RELAY).open).toHaveLength(0);
  });

  it('sweeps on an interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const store = syntheticStore();
      const setup = await harness({ stores: [store] });
      const visitor = 'b'.repeat(64);
      const session = await setup.state.session(store.owner, store.assistant, visitor, NOW);
      setup.clock.now = session.sessionEnd;
      session.history = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
      await seedHistory(setup.db, session);
      vi.advanceTimersByTime(60_000);
      expect(setup.state.sweepCalls).toBeGreaterThan(0);
      await setup.state.lastSweep;
      expect(
        (await setup.state.session(store.owner, store.assistant, visitor, NOW)).history,
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ask for a store with no catalog gets error and frees its reservation', async () => {
    const store = syntheticStore();
    const withoutConfig = { ...store, events: store.events.slice(1) };
    const setup = await harness({ stores: [withoutConfig] });
    expect(setup.worker.catalogs.has(store.owner)).toBe(false);
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'a9'.repeat(16));
    await waitUntil(() => received(setup, store, visitorSecret).length === 1);
    await setup.worker.idle();
    expect(received(setup, store, visitorSecret)[0]?.message).toEqual({
      type: 'unavailable',
      ask_id: 'a9'.repeat(16),
      reason: 'error',
    });
    expect(await day(setup, store)).toEqual({ spent: '0', reserved: '0' });
  });

  it('a restart with a reload retry pending still reloads', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    relay.closeOn = (filters) => filters.some((filter) => filter.kinds?.includes(KIND_CONFIG));
    const before = ownerReloads(setup, store);
    relay.accept(listing(store.catalogSecret, 'restart', NOW - 10));
    await waitUntil(() => ownerReloads(setup, store) === before + 1);
    setup.worker.stop();
    relay.closeOn = undefined;
    await setup.worker.start();
    expect(setup.worker.catalogs.get(store.owner)?.items.size).toBe(3);
  });

  it('a relay sending events nobody asked for cannot hold the queue', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    let serial = 0;
    relay.stray = () =>
      Array.from({ length: 500 }, () => {
        serial += 1;
        return {
          ...listing(store.catalogSecret, 'x', NOW),
          id: serial.toString(16).padStart(64, '0'),
          pubkey: 'f'.repeat(64),
        };
      });
    const before = ownerReloads(setup, store);
    relay.accept(listing(store.catalogSecret, 'stray', NOW - 10));
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 3);
    await setup.worker.catalogsSettled();
    expect(ownerReloads(setup, store) - before).toBeLessThanOrEqual(2);
  });

  it('a worker stopped while starting leaves no sweep running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const store = syntheticStore();
      const setup = await harness({ stores: [store], idle: true });
      const started = setup.worker.start();
      setup.worker.stop();
      await started;
      vi.advanceTimersByTime(120_000);
      expect(setup.state.sweepCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a relay that keeps closing the live REQ meets a growing backoff, not a reload storm', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    const opens = () => relay.requests.filter((filters) => filters[0]?.limit === 0).length;
    const before = opens();
    relay.closeOn = (filters) => filters[0]?.limit === 0;
    relay.open
      .filter((subscription) => subscription.filters[0]?.limit === 0)
      .forEach((subscription) => subscription.params.onclose?.('closed by relay'));
    // Delays of 0.5-1 s, 1-2 s, 2-4 s: at most three reopens in 4.2 s; a reset each time allows four or more.
    await pause(4_200);
    expect(opens() - before).toBeLessThanOrEqual(3);
  });
});

/** Junk deletions by `author`, 500 per page, each page older than the last: a relay that never runs out. */
function endlessPages(author: string, pages: number) {
  let serial = 0;
  let served = 0;
  return (filters: { authors?: string[]; kinds?: number[] }[]) => {
    if (served >= pages || !filters.some((filter) => filter.authors?.includes(author))) {
      return [];
    }
    served += 1;
    return Array.from({ length: 500 }, () => {
      serial += 1;
      return {
        id: serial.toString(16).padStart(64, '0'),
        pubkey: author,
        created_at: NOW - 100_000 - serial,
        kind: KIND_DELETION,
        tags: [],
        content: '',
        sig: '',
      };
    });
  };
}

function paycoreStore() {
  const ownerSecret = generateSecretKey();
  const storeSecret = generateSecretKey();
  const assistantSecret = generateSecretKey();
  const storeKey = getPublicKey(storeSecret);
  const config = finalizeEvent(
    buildConfigEvent(
      {
        assistant: getPublicKey(assistantSecret),
        origins: [ORIGIN],
        name: 'Pay Core Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'paycore' },
        catalogKey: storeKey,
        policyKey: getPublicKey(generateSecretKey()),
        createdAt: NOW - 100,
      },
      ownerSecret,
    ),
    ownerSecret,
  );
  const store: SyntheticStore = {
    ownerSecret,
    owner: getPublicKey(ownerSecret),
    assistantSecret,
    assistant: getPublicKey(assistantSecret),
    catalogSecret: storeSecret,
    catalogKey: storeKey,
    events: [config, listing(storeSecret, 'paycore-item', NOW - 50)],
  };
  const storeAuth = finalizeEvent(
    buildStoreAuthEvent({ storePubkey: storeKey, mode: 'hosted', createdAt: NOW - 100 }),
    ownerSecret,
  );
  return { store, storeAuth };
}

describe('worker review round 3', () => {
  it('a turn that ends after its session ended is charged what it spent, and a queued ask is not started', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'b1'.repeat(16));
    await waitUntil(() => provider.requests.length === 1);
    ask(setup, store, visitorSecret, 'b2'.repeat(16));
    await pause(50);
    const session = await setup.state.storedSession(store.assistant, getPublicKey(visitorSecret));
    if (!session) {
      throw new Error('no session');
    }
    setup.clock.now = session.sessionEnd + 5;
    provider.release();
    await setup.worker.idle();
    expect(provider.requests).toHaveLength(1);
    // Settled into the day the reservation was made.
    expect(await setup.state.dayTotals(store.owner, NOW)).toEqual({
      spent: costOf(SMALL_USAGE, PRICE).toString(),
      reserved: '0',
    });
    expect(
      received(setup, store, visitorSecret).some((opened) => opened.message.type === 'answer'),
    ).toBe(false);
  });

  it('reads wraps from ten minutes back', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    await waitUntil(() => wrapRequests(setup).length === 1);
    expect(wrapRequests(setup)[0]?.filters[0]?.since).toBe(NOW - 10 * 60);
  });

  it('a relay that keeps closing the wrap REQ meets a growing backoff', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    await waitUntil(() => wrapRequests(setup).length === 1);
    const opens = () =>
      relay.requests.filter((filters) => filters.some((filter) => filter.kinds?.includes(1059)))
        .length;
    const before = opens();
    relay.closeOn = (filters) => filters.some((filter) => filter.kinds?.includes(1059));
    wrapRequests(setup).forEach((subscription) => subscription.params.onclose?.('closed by relay'));
    await pause(4_200);
    expect(opens() - before).toBeLessThanOrEqual(3);
  });

  it('caps the pages a relay can make one reload read', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    relay.stray = endlessPages(store.owner, 60);
    const before = ownerReloads(setup, store);
    relay.accept(listing(store.catalogSecret, 'capped', NOW - 10));
    await waitUntil(() => ownerReloads(setup, store) > before);
    await setup.worker.catalogsSettled();
    await waitUntil(() => setup.worker.catalogs.get(store.owner)?.items.size === 3);
    expect(ownerReloads(setup, store) - before).toBe(40);
  });

  it('a slow default relay holds a Pay Core reload only for its time budget', async () => {
    const { store, storeAuth } = paycoreStore();
    const started = Date.now();
    const setup = await harness({
      stores: [store],
      extraRelayBudgetMs: 200,
      configurePool: (pool) => {
        pool.relay('wss://relay.damus.io').accept(storeAuth);
        const slow = pool.relay('wss://nos.lol');
        slow.delayMs = 60;
        slow.stray = endlessPages(store.owner, 1_000);
      },
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(setup.worker.catalogs.get(store.owner)?.items.size).toBe(1);
  });

  it('a store read in full that names another assistant is unservable, not loading', async () => {
    const store = syntheticStore();
    // The database holds another assistant key than the one the config names.
    const otherAssistant = generateSecretKey();
    const record = storeRecord({
      ...store,
      assistantSecret: otherAssistant,
      assistant: getPublicKey(otherAssistant),
    });
    const setup = await harness({ stores: [store], records: [record] });
    expect(setup.worker.catalogs.has(store.owner)).toBe(false);
    expect(setup.worker.isUnservable(store.owner)).toBe(true);
  });

  it('a store dropped while its reload reads does not come back when the read ends', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const relay = setup.pool.relay(RELAY);
    relay.delayMs = 100;
    const before = ownerReloads(setup, store);
    relay.accept(listing(store.catalogSecret, 'dropped', NOW - 10));
    await waitUntil(() => ownerReloads(setup, store) > before);
    await setStatus(setup, store, 'suspended');
    await setup.worker.refreshLeases();
    await pause(600);
    expect(setup.worker.catalogs.has(store.owner)).toBe(false);
  });

  it('a re-issue on a connection that stayed up keeps it counted as stable for the backoff', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store], stableConnectionMs: 300 });
    const relay = setup.pool.relay(RELAY);
    const live = () => relay.requests.filter((filters) => filters[0]?.limit === 0).length;
    const closeLive = () =>
      liveRequests(setup).forEach((subscription) =>
        subscription.params.onclose?.('closed by relay'),
      );
    // Two failed reopens grow the backoff to its third step (2-4 s).
    relay.closeOn = (filters) => filters[0]?.limit === 0;
    const base = live();
    closeLive();
    await waitUntil(() => live() >= base + 2, 4_000);
    relay.closeOn = undefined;
    await waitUntil(() => liveRequests(setup).length === 1, 5_000);
    await pause(400);
    // A re-issue on the same connection, then a close: the connection was up long enough.
    const nextSecret = generateSecretKey();
    relay.accept(
      finalizeEvent(
        buildCatalogAuth({ key: getPublicKey(nextSecret), mode: 'hosted', createdAt: NOW - 20 }),
        store.ownerSecret,
      ),
    );
    relay.accept(
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: store.assistant,
            origins: [ORIGIN],
            name: 'Example Shop',
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: getPublicKey(nextSecret),
            createdAt: NOW - 20,
          },
          store.ownerSecret,
        ),
        store.ownerSecret,
      ),
    );
    const reissued = live();
    await waitUntil(() => live() > reissued);
    const beforeClose = live();
    closeLive();
    await waitUntil(() => live() > beforeClose, 1_500);
  });
});

describe('worker review round 4', () => {
  it('a session replaced while its turn runs is charged what the turn spent', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'c1'.repeat(16));
    await waitUntil(() => provider.requests.length === 1);
    const session = await setup.state.storedSession(store.assistant, getPublicKey(visitorSecret));
    if (!session) {
      throw new Error('no session');
    }
    // A resend inside the end margin starts a fresh session while the turn still runs.
    setup.clock.now = session.sessionEnd - 200;
    ask(setup, store, visitorSecret, 'c2'.repeat(16));
    await waitUntil(
      async () =>
        (await setup.state.storedSession(store.assistant, getPublicKey(visitorSecret)))?.id !==
        session.id,
    );
    provider.release();
    await waitUntil(() => provider.requests.length === 2);
    provider.release();
    await setup.worker.idle();
    expect(await setup.state.dayTotals(store.owner, NOW)).toEqual({
      spent: costOf(SMALL_USAGE, PRICE).toString(),
      reserved: '0',
    });
  });

  it('a wrap REQ on a connection that stayed up resets its backoff', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store], stableConnectionMs: 300 });
    const relay = setup.pool.relay(RELAY);
    const opens = () =>
      relay.requests.filter((filters) => filters.some((filter) => filter.kinds?.includes(1059)))
        .length;
    const closeWraps = () =>
      wrapRequests(setup).forEach((subscription) =>
        subscription.params.onclose?.('closed by relay'),
      );
    await waitUntil(() => wrapRequests(setup).length === 1);
    relay.closeOn = (filters) => filters.some((filter) => filter.kinds?.includes(1059));
    const base = opens();
    closeWraps();
    await waitUntil(() => opens() >= base + 2, 4_000);
    relay.closeOn = undefined;
    await waitUntil(() => wrapRequests(setup).length === 1, 5_000);
    await pause(400);
    const beforeClose = opens();
    closeWraps();
    await waitUntil(() => opens() > beforeClose, 1_500);
  });

  it('a wrap re-issue on a connection that stayed up keeps it counted as stable', async () => {
    const store = syntheticStore();
    const later = syntheticStore();
    const setup = await harness({
      stores: [store, later],
      records: [storeRecord(store), storeRecord(later, 'pending')],
      stableConnectionMs: 300,
    });
    const relay = setup.pool.relay(RELAY);
    const opens = () =>
      relay.requests.filter((filters) => filters.some((filter) => filter.kinds?.includes(1059)))
        .length;
    const closeWraps = () =>
      wrapRequests(setup).forEach((subscription) =>
        subscription.params.onclose?.('closed by relay'),
      );
    await waitUntil(() => wrapRequests(setup).length === 1);
    relay.closeOn = (filters) => filters.some((filter) => filter.kinds?.includes(1059));
    const base = opens();
    closeWraps();
    await waitUntil(() => opens() >= base + 2, 4_000);
    relay.closeOn = undefined;
    await waitUntil(() => wrapRequests(setup).length === 1, 5_000);
    await pause(400);
    // A re-issue on the same connection, then a close.
    const reissued = opens();
    await setStatus(setup, later, 'active');
    await setup.worker.refreshLeases();
    await waitUntil(() => opens() > reissued);
    await waitUntil(() => wrapRequests(setup).length === 1);
    const beforeClose = opens();
    closeWraps();
    await waitUntil(() => opens() > beforeClose, 1_500);
  });
});

describe('server core review: worker', () => {
  it('a running record under a dead lease is re-run on a resend', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    const visitorSecret = generateSecretKey();
    const askId = 'd1'.repeat(16);
    ask(setup, store, visitorSecret, askId);
    await waitUntil(() => provider.requests.length === 1);
    // The first worker is gone with its turn still running before the deadline; another takes the store.
    setup.worker.stop();
    await setup.state.releaseLeases(HOLDER);
    const second = new Worker({
      relayUrl: RELAY,
      state: setup.state,
      pool: setup.pool,
      gatewayKeys: [getPublicKey(setup.gatewaySecret)],
      providerFor: () => provider,
      price: PRICE,
      holder: 'second-worker',
      reserveUsd: '0.25',
      now: () => setup.clock.now,
    });
    running.push(second);
    await second.start();
    expect(second.leaseOf(store.assistant)?.epoch).toBe(2);
    ask(setup, store, visitorSecret, askId);
    await waitUntil(() => provider.requests.length === 2);
    provider.release();
    await second.idle();
    const answers = received(setup, store, visitorSecret).filter(
      (opened) => opened.message.type === 'answer',
    );
    expect(answers.map((opened) => opened.message.ask_id)).toEqual([askId]);
  });

  it('a worker whose lease moved on drops an ask silently and reserves nothing', async () => {
    const store = syntheticStore();
    const provider = scriptedProvider(['Here.']);
    const setup = await harness({ stores: [store], provider });
    // Another instance took the store; this worker has not refreshed its leases yet.
    await setup.db.query(
      `update leases set holder = 'other', epoch = epoch + 1, expires_at = $2 where owner = $1`,
      [store.owner, setup.clock.now + 60],
    );
    const visitorSecret = generateSecretKey();
    ask(setup, store, visitorSecret, 'd2'.repeat(16));
    await waitUntil(() => setup.logs.includes('ask dropped: superseded'));
    await setup.worker.idle();
    expect(received(setup, store, visitorSecret)).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(await day(setup, store)).toEqual({ spent: '0', reserved: '0' });
  });

  it('two asks of one session read back to back are taken in arrival order', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    const visitorSecret = generateSecretKey();
    // The first intake is slow: the second must still wait behind it.
    setup.state.rumorSeenDelaysMs.push(200);
    ask(setup, store, visitorSecret, 'e1'.repeat(16));
    ask(setup, store, visitorSecret, 'e2'.repeat(16));
    await waitUntil(() => received(setup, store, visitorSecret).length === 2);
    await setup.worker.idle();
    expect(received(setup, store, visitorSecret).map((opened) => opened.message.ask_id)).toEqual([
      'e1'.repeat(16),
      'e2'.repeat(16),
    ]);
  });

  it('a shutdown waits for a turn in flight only so long, then gives the leases up', async () => {
    const store = syntheticStore();
    const provider = heldProvider();
    const setup = await harness({ stores: [store], provider });
    ask(setup, store, generateSecretKey(), 'f1'.repeat(16));
    await waitUntil(() => provider.requests.length === 1);
    const started = Date.now();
    await setup.worker.shutdown(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    const taken = await setup.state.acquireLeases('other', setup.clock.now, 60);
    expect(taken.map((lease) => lease.store.owner)).toEqual([store.owner]);
    provider.release();
  });
});

describe('server core review 2: worker', () => {
  it('a turn whose answer step fails after its model calls settles what they spent', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    setup.state.answerFails = true;
    const visitorSecret = generateSecretKey();
    const askId = 'a7'.repeat(16);
    ask(setup, store, visitorSecret, askId);
    await waitUntil(() => received(setup, store, visitorSecret).length > 0);
    await setup.worker.idle();
    expect(received(setup, store, visitorSecret).map((opened) => opened.message)).toContainEqual({
      type: 'unavailable',
      ask_id: askId,
      reason: 'error',
    });
    expect(await day(setup, store)).toEqual({
      spent: costOf(SMALL_USAGE, PRICE).toString(),
      reserved: '0',
    });
  });

  it('a shutdown waits for a lease renewal in flight before giving the leases up', async () => {
    const store = syntheticStore();
    const setup = await harness({ stores: [store] });
    let openGate: () => void = () => undefined;
    setup.state.leaseGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const renewal = setup.worker.refreshLeases();
    await waitUntil(() => setup.state.leaseGateEntered);
    const shutdown = setup.worker.shutdown(100);
    await new Promise((resolve) => setTimeout(resolve, 50));
    openGate();
    await shutdown;
    await renewal;
    setup.state.leaseGate = undefined;
    const taken = await setup.state.acquireLeases('other', setup.clock.now, 60);
    expect(taken.map((lease) => lease.store.owner)).toEqual([store.owner]);
  });
});
