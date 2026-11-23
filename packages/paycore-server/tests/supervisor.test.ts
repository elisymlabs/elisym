import type { LedgerState } from '@merchant-node/ledger';
import { startStoreNode } from '@merchant-node/store-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chain, landedPayment, requestFor, signatureOf } from '../../merchant-node/tests/fixtures';
import type { TransportRequest } from '../src/connectors/fetch-guard';
import type { Db } from '../src/db/db';
import { MAX_FAILED_STARTS, type StoreSupervisor } from '../src/node/supervisor';
import { LEASE_TTL_SECS, newHolderId } from '../src/state/leases';
import { PgLedgerStore } from '../src/state/ledger-store';
import { WebhookSlots } from '../src/webhook-fetch';
import {
  NOW,
  PRODUCT,
  RELAY,
  WEBHOOK_SECRET,
  key,
  lease,
  openAlerts,
  orderWraps,
  seedStore,
  settle,
  sellingLedger,
  storeStatus,
  storedLedger,
  testSupervisor,
  vault,
  waitFor,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-00000000c001';
const TX = signatureOf(7);
const HOOK_URL = 'https://shop.example.com/hook';

const supervisors: StoreSupervisor[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});

function track<Value extends { supervisor: StoreSupervisor }>(value: Value): Value {
  supervisors.push(value.supervisor);
  return value;
}

/** A Solana chain where `tx` paid the order `orderId` of `buyer` at `store`. */
async function paidChain(store: ReturnType<typeof key>, buyer: ReturnType<typeof key>) {
  const wraps = orderWraps(store, buyer, ORDER_ID, TX);
  const { rpc } = chain({
    [TX]: await landedPayment(requestFor(wraps.reference), { blockTime: NOW - 30 }),
  });
  return { wraps, rpc };
}

async function delivered(db: Db, owner: string, orderKey: string): Promise<boolean> {
  return (await storedLedger(db, owner)).orders[orderKey]?.deliveredAt !== undefined;
}

/** Bump the fence under the running holder, as a takeover that saved would. */
async function bumpRow(
  db: Db,
  owner: string,
  change: (state: LedgerState) => void = () => undefined,
) {
  const state = await storedLedger(db, owner);
  change(state);
  await db.query('update ledgers set state = $2, row_version = row_version + 1 where owner = $1', [
    owner,
    JSON.stringify(state),
  ]);
}

describe('file vs pg LedgerStore parity', () => {
  it('saves the same ledger for an order, its paid receipt, its delivery and its webhook', async () => {
    const store = key();
    const buyer = key();
    const { wraps, rpc } = await paidChain(store, buyer);
    const webhookSends: string[] = [];

    async function run(save: (state: LedgerState) => Promise<void>, state: LedgerState) {
      const world = new RelayWorld();
      const pool = world.pool();
      const node = await startStoreNode({
        pool,
        config: {
          name: 'Shop',
          network: 'devnet',
          payouts: [],
          inboxRelays: [RELAY],
          rpcUrl: 'https://rpc',
        },
        products: new Map([[PRODUCT.d, PRODUCT]]),
        state,
        storePubkey: store.pubkey,
        storeSecretKey: store.secretKey,
        solanaRpc: rpc,
        save: () => save(state),
        refreshTreasuries: async () => ({ kind: 'unreachable', problem: 'offline' }),
        eip3009: [],
        outbox: { storePubkey: store.pubkey, now: () => NOW },
        webhook: {
          target: { url: HOOK_URL, secret: WEBHOOK_SECRET },
          userAgent: 'test',
          fetch: async (url) => {
            webhookSends.push(url);
            return new Response(null, { status: 200 });
          },
        },
        log: () => undefined,
        now: () => NOW,
        stop: () => undefined,
        haltOnSaveFailure: true,
      });
      world.deliver(wraps.order);
      world.deliver(wraps.receipt);
      await waitFor(() => state.orders[wraps.key]?.webhook?.state === 'sent', 'the webhook sent');
      await node.stop();
    }

    const snapshots: string[] = [];
    const fileState = sellingLedger();
    await run(async (state) => {
      snapshots.push(JSON.stringify(state, null, 2));
    }, fileState);

    const db = await freshDb();
    const keys = vault();
    const { owner } = await seedStore(db, keys, { store });
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const handle = await new PgLedgerStore(db, () => NOW).open(
      owner.pubkey,
      leased?.epoch ?? 0,
      holder,
    );
    await run((state) => handle.save(state), handle.state);

    const fileSaved = JSON.parse(snapshots.at(-1) ?? '{}') as LedgerState;
    expect(fileSaved.orders[wraps.key]?.webhook?.state).toBe('sent');
    expect(await storedLedger(db, owner.pubkey)).toEqual(fileSaved);
    expect(webhookSends).toEqual([HOOK_URL, HOOK_URL]);
  });
});

describe('StoreSupervisor', () => {
  it('isolates stores: one whose save is refused halts, another keeps completing orders', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const failing = await seedStore(db, keys);
    const healthy = await seedStore(db, keys);
    const buyer = key();
    const { wraps, rpc } = await paidChain(healthy.store, buyer);
    const holder = newHolderId();
    const { supervisor } = track(testSupervisor(db, keys, holder, world, rpc));
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    expect(supervisor.running.sort()).toEqual([failing.owner.pubkey, healthy.owner.pubkey].sort());

    await bumpRow(db, failing.owner.pubkey);
    world.deliver(orderWraps(failing.store, buyer, ORDER_ID, TX).order);
    await waitFor(() => !supervisor.running.includes(failing.owner.pubkey), 'the halt');
    await supervisor.idle();
    expect((await openAlerts(db, failing.owner.pubkey)).map((alert) => alert.kind)).toEqual([
      'node_stopped',
    ]);

    world.deliver(wraps.order);
    world.deliver(wraps.receipt);
    await waitFor(() => delivered(db, healthy.owner.pubkey, wraps.key), 'the healthy order');
    expect(supervisor.running).toEqual([healthy.owner.pubkey]);
    expect(await openAlerts(db, healthy.owner.pubkey)).toEqual([]);
  });

  it('fences a holder whose lease moved: it halts, and the new holder reloads what was saved', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner, store } = await seedStore(db, keys);
    const first = newHolderId();
    const old = track(testSupervisor(db, keys, first, world, chain({}).rpc));
    old.supervisor.reconcile(await lease(db, first));
    await old.supervisor.idle();
    const earlier = orderWraps(store, key(), ORDER_ID, TX);
    world.deliver(earlier.order);
    await waitFor(
      async () => (await storedLedger(db, owner.pubkey)).orders[earlier.key] !== undefined,
      'the first order saved',
    );

    const later = NOW + LEASE_TTL_SECS + 1;
    const second = newHolderId();
    const takeover = track(
      testSupervisor(db, keys, second, world, chain({}).rpc, { now: () => later }),
    );
    const leased = await lease(db, second, later);
    expect(leased[0]?.epoch).toBe(2);
    takeover.supervisor.reconcile(leased);
    await takeover.supervisor.idle();
    // The new run's first save writes the ledger it loaded: the order saved before is in it.
    const reloaded = await db.query<{ lease_epoch: number; state: string }>(
      'select lease_epoch, state from ledgers where owner = $1',
      [owner.pubkey],
    );
    expect(reloaded[0]?.lease_epoch).toBe(2);
    expect(
      (JSON.parse(reloaded[0]?.state ?? '{}') as LedgerState).orders[earlier.key],
    ).toBeDefined();

    const next = orderWraps(store, key(), 'b3a7c2d4-0000-4000-8000-00000000c002', TX);
    world.deliver(next.order);
    await waitFor(() => !old.supervisor.running.includes(owner.pubkey), 'the stale holder halts');
    await old.supervisor.idle();
    await waitFor(
      async () => (await storedLedger(db, owner.pubkey)).orders[next.key] !== undefined,
      'the new holder saved the order',
    );
    expect(takeover.supervisor.running).toEqual([owner.pubkey]);
    expect(old.logs.some((line) => line.includes('the lease moved: not retried here'))).toBe(true);
  });

  it('applies a control task on a fresh handle after a conflict halt, never the halted memory', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner, store } = await seedStore(db, keys);
    const holder = newHolderId();
    const { supervisor } = track(testSupervisor(db, keys, holder, world, chain({}).rpc));
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    await bumpRow(db, owner.pubkey, (state) => {
      state.seenRumors.marker = true;
    });
    const unsaved = orderWraps(store, key(), ORDER_ID, TX);
    world.deliver(unsaved.order);
    await waitFor(() => !supervisor.running.includes(owner.pubkey), 'the halt');
    const seen = await supervisor.applyControl(owner.pubkey, async (handle) => {
      const marked = handle.state.seenRumors.marker === true;
      const hasUnsaved = handle.state.orders[unsaved.key] !== undefined;
      handle.state.seenRumors.applied = true;
      await handle.save(handle.state);
      return { marked, hasUnsaved };
    });
    expect(seen).toEqual({ marked: true, hasUnsaved: false });
    expect(supervisor.running).toEqual([owner.pubkey]);
    const restarted = await storedLedger(db, owner.pubkey);
    expect(restarted.seenRumors.applied).toBe(true);
    expect(restarted.seenRumors.marker).toBe(true);
    expect(restarted.orders[unsaved.key]).toBeUndefined();
  });

  it('never lets a payment of one store be claimed by another sharing its payout', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const first = await seedStore(db, keys);
    const second = await seedStore(db, keys);
    const buyer = key();
    const { wraps, rpc } = await paidChain(first.store, buyer);
    const same = orderWraps(second.store, buyer, ORDER_ID, TX);
    const holder = newHolderId();
    const { supervisor } = track(testSupervisor(db, keys, holder, world, rpc));
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    world.deliver(same.order);
    world.deliver(same.receipt);
    world.deliver(wraps.order);
    world.deliver(wraps.receipt);
    await waitFor(() => delivered(db, first.owner.pubkey, wraps.key), 'the paid order');
    await waitFor(
      async () =>
        (await storedLedger(db, second.owner.pubkey)).orders[same.key]?.reportedTxs.includes(TX) ===
        true,
      'the other receipt read',
    );
    await supervisor.idle();
    const other = await storedLedger(db, second.owner.pubkey);
    expect(other.orders[same.key]?.paid).toBeUndefined();
    expect(other.claims[TX]).toBeUndefined();
    expect((await storedLedger(db, first.owner.pubkey)).claims[TX]).toBe(wraps.key);
  });

  it('refuses a store its data cannot run: halted with an alert at once, still leased', async () => {
    const db = await freshDb();
    const keys = vault();
    const { owner } = await seedStore(db, keys, { inboxRelays: ['wss://other.example.com'] });
    const holder = newHolderId();
    const { supervisor } = track(testSupervisor(db, keys, holder, new RelayWorld(), chain({}).rpc));
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    expect(supervisor.running).toEqual([]);
    expect(await storeStatus(db, owner.pubkey)).toBe('halted');
    expect((await openAlerts(db, owner.pubkey)).map((alert) => alert.kind)).toEqual([
      'start_refused',
    ]);
    expect((await lease(db, holder)).map((leased) => leased.owner)).toEqual([owner.pubkey]);
  });

  it('retries failed starts after 30 s doubling, halts after three in a row, and clears it all on a start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = await freshDb();
    const keys = vault();
    const { owner } = await seedStore(db, keys);
    const holder = newHolderId();
    let reads = 0;
    let failing = true;
    const { supervisor } = track(
      testSupervisor(db, keys, holder, new RelayWorld(), chain({}).rpc, {
        treasuries: {
          refreshFor: async () => {
            reads += 1;
            if (failing) {
              throw new Error('config RPC down');
            }
            return { kind: 'unreachable', problem: 'offline' };
          },
        },
      }),
    );
    const step = async (ms: number) => {
      vi.advanceTimersByTime(ms);
      await supervisor.idle();
    };
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    expect(reads).toBe(1);
    await step(29_999);
    expect(reads).toBe(1);
    await step(1);
    expect(reads).toBe(2);
    expect(await storeStatus(db, owner.pubkey)).toBe('active');
    await step(59_999);
    expect(reads).toBe(2);
    await step(1);
    expect(reads).toBe(MAX_FAILED_STARTS);
    expect(await storeStatus(db, owner.pubkey)).toBe('halted');
    expect((await openAlerts(db, owner.pubkey)).map((alert) => alert.kind)).toEqual([
      'start_failed',
    ]);
    await step(119_999);
    expect(reads).toBe(3);
    failing = false;
    await step(1);
    // The fourth start's read, then the first sweep's.
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(supervisor.running).toEqual([owner.pubkey]);
    expect(await storeStatus(db, owner.pubkey)).toBe('active');
    expect(await openAlerts(db, owner.pubkey)).toEqual([]);
  });

  it('counts a node that stops itself right after starting toward the halt (decision 3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner, store } = await seedStore(db, keys);
    const holder = newHolderId();
    const { supervisor } = track(testSupervisor(db, keys, holder, world, chain({}).rpc));
    const until = async (check: () => boolean, what: string) => {
      for (let round = 0; round < 200 && !check(); round += 1) {
        await settle(5);
      }
      if (!check()) {
        throw new Error(`never: ${what}`);
      }
      await supervisor.idle();
    };
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    const backoffs = [30_000, 60_000];
    for (let stop = 1; stop <= MAX_FAILED_STARTS; stop += 1) {
      expect(supervisor.running).toEqual([owner.pubkey]);
      await bumpRow(db, owner.pubkey);
      world.deliver(
        orderWraps(store, key(), `b3a7c2d4-0000-4000-8000-00000000c10${stop}`, TX).order,
      );
      await until(() => supervisor.running.length === 0, `stop ${stop}`);
      if (stop < MAX_FAILED_STARTS) {
        expect(await storeStatus(db, owner.pubkey)).toBe('active');
        vi.advanceTimersByTime(backoffs[stop - 1] ?? 0);
        await until(() => supervisor.running.length === 1, `restart ${stop}`);
      }
    }
    expect(await storeStatus(db, owner.pubkey)).toBe('halted');
    expect((await openAlerts(db, owner.pubkey)).map((alert) => alert.kind)).toEqual([
      'node_stopped',
      'start_failed',
    ]);
  });

  it('restarts a store whose lease epoch changed, and never stops one turned degraded', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const { owner } = await seedStore(db, keys);
    const holder = newHolderId();
    const { supervisor } = track(testSupervisor(db, keys, holder, world, chain({}).rpc));
    const [leased] = await lease(db, holder);
    if (leased === undefined) {
      throw new Error('no lease');
    }
    supervisor.reconcile([leased]);
    await supervisor.idle();
    const node = supervisor.nodeOf(owner.pubkey);
    supervisor.reconcile([{ ...leased, status: 'degraded' }]);
    await supervisor.idle();
    expect(supervisor.nodeOf(owner.pubkey)).toBe(node);

    await db.query('update leases set expires_at = 0 where owner = $1', [owner.pubkey]);
    const [again] = await lease(db, holder);
    expect(again?.epoch).toBe(leased.epoch + 1);
    supervisor.reconcile(again === undefined ? [] : [again]);
    await supervisor.idle();
    const restarted = supervisor.nodeOf(owner.pubkey);
    expect(restarted).toBeDefined();
    expect(restarted).not.toBe(node);
    expect(world.pools.filter((pool) => !pool.destroyed)).toHaveLength(1);
    // The new run saves under the new epoch.
    const [row] = await db.query<{ lease_epoch: number }>(
      'select lease_epoch from ledgers where owner = $1',
      [owner.pubkey],
    );
    expect(row?.lease_epoch).toBe(leased.epoch + 1);

    supervisor.reconcile([]);
    await supervisor.idle();
    expect(supervisor.running).toEqual([]);
    expect(world.pools.every((pool) => pool.destroyed)).toBe(true);
  });

  it('stops the node before ending its webhook sends: a send refused at stop leaves its entry untouched', async () => {
    const db = await freshDb();
    const keys = vault();
    const world = new RelayWorld();
    const state = sellingLedger();
    const store = key();
    const buyer = key();
    const orderKey = `${buyer.pubkey}:${ORDER_ID}`;
    state.orders[orderKey] = {
      key: orderKey,
      buyerPubkey: buyer.pubkey,
      orderId: ORDER_ID,
      rumorId: 'r'.repeat(64),
      createdAt: NOW - 600,
      reference: 'ref',
      product: `30402:${store.pubkey}:${PRODUCT.d}`,
      reportedTxs: [TX],
      paid: {
        signature: TX,
        amount: '1000000',
        blockTime: NOW - 500,
        caip19: 'x',
        medium: 'solana-devnet',
      },
      deliveredAt: NOW - 400,
      webhook: {
        state: 'pending',
        eventId: 'e'.repeat(64),
        createdAt: NOW - 500,
        deadline: NOW + 3600,
        attempts: 0,
        nextAt: NOW - 10,
      },
    };
    const { owner } = await seedStore(db, keys, {
      store,
      state,
      webhookUrl: HOOK_URL,
      webhookSecret: WEBHOOK_SECRET,
    });
    const requests: TransportRequest[] = [];
    const slots = new WebhookSlots({
      deps: {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: (request) => {
          requests.push(request);
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        },
      },
    });
    const holder = newHolderId();
    const { supervisor } = testSupervisor(db, keys, holder, world, chain({}).rpc, {
      webhookSlots: slots,
    });
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    await waitFor(() => requests.length === 1, 'the webhook request');
    expect(requests[0]?.headers['user-agent']).toBe('paycore-server/test');
    await supervisor.shutdown();
    expect(requests[0]?.signal.aborted).toBe(true);
    const entry = (await storedLedger(db, owner.pubkey)).orders[orderKey]?.webhook;
    expect(entry).toEqual(state.orders[orderKey]?.webhook);
    expect(world.pools.every((pool) => pool.destroyed)).toBe(true);
    const leases = await db.query<{ expires_at: number }>('select expires_at from leases');
    expect(leases).toEqual([{ expires_at: 0 }]);
  });
});
