import type { RelayView } from '@merchant-node/checks';
import { LEDGER_VERSION, type LedgerState, emptyLedger } from '@merchant-node/ledger';
import { buildListingEvent } from '@merchant-node/store-events';
import type { NostrEvent } from 'nostr-tools';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OTHER_TREASURY,
  chain,
  landedPayment,
  requestFor,
  signatureOf,
} from '../../merchant-node/tests/fixtures';
import { loadStoreBundle } from '../src/node/load';
import {
  CONTROL_BACKOFF_MAX_MS,
  HealGate,
  controlBackoffMs,
  healable,
  problemKey,
  startChecks,
} from '../src/node/start-checks';
import { DRIFT_CHECK_SECS, type StoreSupervisor } from '../src/node/supervisor';
import { newHolderId } from '../src/state/leases';
import {
  BASE_DEVNET_CAIP19,
  D,
  NOW,
  PRODUCT,
  RELAY,
  RPCS,
  SILENT_EVM,
  SOLANA_PAYOUTS,
  USDC_DEVNET_CAIP19,
  insertOwnerEvent,
  key,
  lease,
  openAlerts,
  orderWraps,
  ownerEvents,
  publishedStore,
  seedStore,
  sellingLedger,
  storeStatus,
  storedLedger,
  testHeal,
  testSupervisor,
  vault,
  waitFor,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';

const UNREACHABLE = { kind: 'unreachable', problem: 'offline' } as const;

async function checked(options: Parameters<typeof seedStore>[2], world = new RelayWorld()) {
  const db = await freshDb();
  const keys = vault();
  const { owner } = await seedStore(db, keys, options);
  const holder = newHolderId();
  const [leased] = await lease(db, holder);
  const bundle = await loadStoreBundle(db, keys, owner.pubkey, {
    holder,
    epoch: leased?.epoch ?? 0,
    rpcs: RPCS,
    inboxRelayAllowlist: [RELAY],
    now: () => NOW,
  });
  const registered: unknown[] = [];
  const outcome = startChecks(bundle, {
    pool: world.pool(),
    treasuries: { refreshFor: async () => UNREACHABLE },
    boot: {
      register: (contexts) => {
        registered.push(...contexts);
        return () => undefined;
      },
    },
    evmClientFor: () => SILENT_EVM,
    log: () => undefined,
    now: () => NOW,
  });
  return { db, owner, bundle, outcome, registered };
}

describe('startChecks', () => {
  it('saves the upgraded ledger through the fence before any relay is read', async () => {
    const world = new RelayWorld();
    const old = sellingLedger() as unknown as Record<string, unknown>;
    old.version = 4;
    delete old.eip3009Bindings;
    let db: Awaited<ReturnType<typeof freshDb>> | undefined;
    let ownerKey = '';
    const seen: number[] = [];
    world.beforeQuery = async () => {
      if (db !== undefined) {
        seen.push((await storedLedger(db, ownerKey)).version);
      }
    };
    const run = await checked({ state: old as unknown as LedgerState }, world);
    db = run.db;
    ownerKey = run.owner.pubkey;
    const outcome = await run.outcome;
    expect(outcome.kind).toBe('ready');
    expect(world.queries).toBeGreaterThan(0);
    expect(seen.length).toBe(world.queries);
    expect(seen.every((version) => version === LEDGER_VERSION)).toBe(true);
    expect((await storedLedger(run.db, ownerKey)).eip3009Bindings).toEqual({});
  });

  it('saves nothing when the ledger is already of this version', async () => {
    const { outcome, db, owner } = await checked({});
    expect((await outcome).kind).toBe('ready');
    const [row] = await db.query<{ row_version: number }>(
      'select row_version from ledgers where owner = $1',
      [owner.pubkey],
    );
    expect(row?.row_version).toBe(1);
  });

  it('refuses a ledger with a history for a product it no longer has', async () => {
    const { outcome } = await checked({ products: [{ ...PRODUCT, d: 'other' }] });
    const result = await outcome;
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' && result.problem).toContain(`product ${D} has a history`);
  });

  it('refuses products the active payouts cannot price', async () => {
    const { outcome } = await checked({ products: [{ ...PRODUCT, priceUsd: '0.0000001' }] });
    const result = await outcome;
    expect(result.kind === 'refused' && result.problem).toContain('the products are not usable');
  });

  it('refuses the fee config of another cluster', async () => {
    const db = await freshDb();
    const keys = vault();
    const { owner } = await seedStore(db, keys);
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const bundle = await loadStoreBundle(db, keys, owner.pubkey, {
      holder,
      epoch: leased?.epoch ?? 0,
      rpcs: RPCS,
      inboxRelayAllowlist: [RELAY],
      now: () => NOW,
    });
    const outcome = await startChecks(bundle, {
      pool: new RelayWorld().pool(),
      treasuries: { refreshFor: async () => ({ kind: 'wrong_cluster', problem: 'mainnet RPC' }) },
      boot: { register: () => () => undefined },
      evmClientFor: () => SILENT_EVM,
      log: () => undefined,
      now: () => NOW,
    });
    expect(outcome).toEqual({ kind: 'refused', problem: 'mainnet RPC' });
  });

  it('builds the EIP-3009 contexts on the shared clients and registers them with the boot', async () => {
    const state = sellingLedger();
    state.payto = {
      createdAt: NOW,
      payouts: JSON.stringify([
        { caip19: BASE_DEVNET_CAIP19, address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' },
      ]),
    };
    const { outcome, registered } = await checked({
      state,
      webhookUrl: 'https://shop.example.com/hook',
      webhookSecret: 'w'.repeat(64),
    });
    const result = await outcome;
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') {
      return;
    }
    expect(result.eip3009).toHaveLength(1);
    expect(result.eip3009[0]?.client).toBe(SILENT_EVM);
    expect(result.eip3009[0]?.outbox).toBeDefined();
    expect(registered).toEqual(result.eip3009);
  });
});

function listing(id: string, d: string): NostrEvent {
  return { id, kind: 30402, pubkey: 's', created_at: NOW, tags: [['d', d]], content: '', sig: '' };
}

function payto(id: string, createdAt: number): NostrEvent {
  return { id, kind: 10133, pubkey: 'o', created_at: createdAt, tags: [], content: '', sig: '' };
}

function view(fields: Partial<RelayView>): RelayView {
  return { listings: [], payoutList: undefined, inboxList: undefined, ...fields };
}

describe('healable', () => {
  const state = { listings: { [D]: { hash: 'h', eventId: 'l1', createdAt: NOW } } };
  const committed = [{ id: 'p1', kind: 10133, createdAt: NOW - 100, recorded: true }];

  it('heals a listing the ledger did not record', () => {
    expect(healable([view({ listings: [listing('l2', D)] })], state, committed)).toBe(true);
  });

  it('heals a payout list the server committed, or one older than it', () => {
    expect(healable([view({ payoutList: payto('p1', NOW - 100) })], state, committed)).toBe(true);
    expect(healable([view({ payoutList: payto('px', NOW - 200) })], state, committed)).toBe(true);
  });

  it('does not heal a newer payout list the server never committed (R1 drift)', () => {
    const foreign = [view({ listings: [listing('l1', D)], payoutList: payto('px', NOW - 50) })];
    expect(healable(foreign, state, committed)).toBe(false);
    expect(healable([view({ payoutList: payto('px', NOW - 100) })], state, committed)).toBe(false);
    expect(healable([view({ payoutList: payto('px', NOW - 500) })], state, [])).toBe(false);
  });
});

describe('HealGate', () => {
  it('heals each problem set once, spaced by the backoff', () => {
    const gate = new HealGate();
    expect(gate.plan('a', 0)).toBe(0);
    expect(gate.plan('a', 1_000)).toBeUndefined();
    expect(gate.plan('b', 1_000)).toBe(controlBackoffMs(0) - 1_000);
    expect(gate.plan('c', 30_000)).toBe(controlBackoffMs(0) + controlBackoffMs(1) - 30_000);
    gate.reset();
    expect(gate.plan('a', 100_000)).toBe(0);
  });

  it('backs off from 30 s to 30 min', () => {
    expect(controlBackoffMs(0)).toBe(30_000);
    expect(controlBackoffMs(1)).toBe(60_000);
    expect(controlBackoffMs(6)).toBe(CONTROL_BACKOFF_MAX_MS);
    expect(controlBackoffMs(100)).toBe(CONTROL_BACKOFF_MAX_MS);
    expect(problemKey(['b', 'a', 'b'])).toBe(problemKey(['a', 'b']));
  });
});

describe('a store started by the supervisor', () => {
  let running: StoreSupervisor | undefined;
  afterEach(async () => {
    await running?.shutdown();
    running = undefined;
  });

  async function serve(
    world: RelayWorld,
    seed: Awaited<ReturnType<typeof publishedStore>>,
    rpc = chain({}).rpc,
  ) {
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const { heal, heals } = testHeal(db, keys, world);
    const holder = newHolderId();
    const { supervisor, logs } = testSupervisor(db, keys, holder, world, rpc, { heal });
    running = supervisor;
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    return { db, supervisor, heals, logs, holder, owner: seed.owner.pubkey };
  }

  it('runs degraded with one alert and one heal pass when the committed events can fix the offers', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const repriced = { ...PRODUCT, priceUsd: '2' };
    // A setup published the new price and stopped before it wrote the ledger.
    world.add(buildListingEvent(repriced, SOLANA_PAYOUTS, seed.store.secretKey, NOW - 60));
    const { db, supervisor, heals, owner } = await serve(world, { ...seed, products: [repriced] });
    await waitFor(async () => heals.length === 1 && supervisor.running.includes(owner), 'heal');
    await supervisor.idle();
    expect(heals).toEqual([owner]);
    const stored = await storedLedger(db, owner);
    expect(
      stored.terms.some(
        (period) => period.terms.amount === '2000000' && period.until === undefined,
      ),
    ).toBe(true);
    expect(await storeStatus(db, owner)).toBe('active');
    expect(await openAlerts(db, owner)).toEqual([]);
    const raised = await db.query<{ count: number }>(
      "select count from alerts where owner = $1 and kind = 'offer_mismatch'",
      [owner],
    );
    expect(raised).toEqual([{ count: 1 }]);
  });

  it('alerts once (drift and offers) on a newer payout list the server never committed, with no heal and no restart', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const foreign = ownerEvents(
      seed.owner,
      seed.store,
      [{ caip19: USDC_DEVNET_CAIP19, address: OTHER_TREASURY }],
      NOW - 60,
    );
    world.add(foreign.payoutList);
    const { db, supervisor, heals, owner, holder } = await serve(world, seed);
    const node = supervisor.nodeOf(owner);
    expect(node).toBeDefined();
    for (let round = 0; round < 3; round += 1) {
      supervisor.reconcile(await lease(db, holder));
      await supervisor.idle();
    }
    expect(supervisor.nodeOf(owner)).toBe(node);
    expect(heals).toEqual([]);
    expect(await storeStatus(db, owner)).toBe('degraded');
    const alerts = await openAlerts(db, owner);
    // R1 drift: the newest list on the relays is one the server never committed.
    expect(alerts.map((alert) => [alert.kind, alert.count])).toEqual([
      ['drift', 1],
      ['offer_mismatch', 1],
    ]);
    expect(alerts[0]?.message).toContain(foreign.payoutList.id);
    expect(alerts[1]?.message).toContain(OTHER_TREASURY);
  });

  it('heals a committed payout list that went out and was never recorded: the active list switches', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const next = [{ caip19: USDC_DEVNET_CAIP19, address: OTHER_TREASURY }];
    const committed = ownerEvents(seed.owner, seed.store, next, NOW - 60);
    world.add(committed.payoutList);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    await insertOwnerEvent(
      db,
      seed.owner.pubkey,
      committed.payoutList,
      JSON.stringify(next),
      false,
    );
    const { heal, heals } = testHeal(db, keys, world);
    const holder = newHolderId();
    const { supervisor } = testSupervisor(db, keys, holder, world, chain({}).rpc, { heal });
    running = supervisor;
    const owner = seed.owner.pubkey;
    supervisor.reconcile(await lease(db, holder));
    await waitFor(async () => heals.length === 1 && supervisor.running.includes(owner), 'heal');
    await supervisor.idle();
    const stored = await storedLedger(db, owner);
    expect(stored.payto).toEqual({ createdAt: NOW - 60, payouts: JSON.stringify(next) });
    expect(heals).toHaveLength(1);
    expect(await storeStatus(db, owner)).toBe('active');
    expect(await openAlerts(db, owner)).toEqual([]);
  });

  it('keeps the active payouts and rails when only the draft changed, and completes an open order there', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const buyer = key();
    const tx = signatureOf(9);
    const wraps = orderWraps(seed.store, buyer, 'b3a7c2d4-0000-4000-8000-00000000c001', tx);
    const { rpc } = chain({
      [tx]: await landedPayment(requestFor(wraps.reference), { blockTime: NOW - 30 }),
    });
    // The merchant edited the draft to Base only, then the store restarted before signing it.
    const draft = [
      { caip19: BASE_DEVNET_CAIP19, address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' },
    ];
    const { db, supervisor, owner } = await serve(world, { ...seed, draftPayouts: draft }, rpc);
    expect(supervisor.running).toEqual([owner]);
    world.deliver(wraps.order);
    world.deliver(wraps.receipt);
    await waitFor(
      async () => (await storedLedger(db, owner)).orders[wraps.key]?.deliveredAt !== undefined,
      'the order completed',
    );
    const stored = await storedLedger(db, owner);
    expect(stored.orders[wraps.key]?.paid?.signature).toBe(tx);
    expect(JSON.parse(stored.payto?.payouts ?? '[]')).toEqual(SOLANA_PAYOUTS);
  });
});

describe('the periodic drift and offer check', () => {
  let running: StoreSupervisor | undefined;
  afterEach(async () => {
    await running?.shutdown();
    running = undefined;
  });

  it('reads a running store every DRIFT_CHECK_SECS with its own pool: degraded on drift, active again once it is gone', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const { heal, heals } = testHeal(db, keys, world);
    const holder = newHolderId();
    let clock = NOW;
    const { supervisor } = testSupervisor(db, keys, holder, world, chain({}).rpc, {
      heal,
      now: () => clock,
    });
    running = supervisor;
    const owner = seed.owner.pubkey;
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    const node = supervisor.nodeOf(owner);
    expect(await storeStatus(db, owner)).toBe('active');
    const pools = world.pools.length;

    const foreign = ownerEvents(
      seed.owner,
      seed.store,
      [{ caip19: USDC_DEVNET_CAIP19, address: OTHER_TREASURY }],
      NOW - 60,
    );
    world.add(foreign.payoutList);
    const queries = world.queries;
    await supervisor.recheckOffers();
    expect(world.queries).toBe(queries);
    expect(await storeStatus(db, owner)).toBe('active');

    clock += DRIFT_CHECK_SECS;
    await supervisor.recheckOffers();
    expect(world.queries).toBeGreaterThan(queries);
    expect(await storeStatus(db, owner)).toBe('degraded');
    expect((await openAlerts(db, owner)).map((alert) => alert.kind)).toEqual([
      'drift',
      'offer_mismatch',
    ]);
    expect(heals).toEqual([]);
    expect(supervisor.nodeOf(owner)).toBe(node);
    expect(world.pools.length).toBe(pools);

    world.events.splice(world.events.indexOf(foreign.payoutList), 1);
    clock += DRIFT_CHECK_SECS;
    await supervisor.recheckOffers();
    expect(await storeStatus(db, owner)).toBe('active');
    expect(await openAlerts(db, owner)).toEqual([]);
    expect(supervisor.nodeOf(owner)).toBe(node);
  });
});

describe('an empty ledger', () => {
  it('starts with no payouts and no rail', async () => {
    const { outcome, bundle } = await checked({ state: emptyLedger(), products: [] });
    expect((await outcome).kind).toBe('ready');
    expect(bundle.config.payouts).toEqual([]);
    expect(bundle.rails).toEqual({ solana: false, tempo: false, evm: [] });
  });
});
