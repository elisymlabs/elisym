import { emptyLedger } from '@merchant-node/ledger';
import { afterEach, describe, expect, it } from 'vitest';
import { chain, landedPayment, requestFor, signatureOf } from '../../merchant-node/tests/fixtures';
import { getRequest } from '../src/admin/requests';
import type { Db } from '../src/db/db';
import { HolderRequests } from '../src/node/holder-requests';
import { TERMS_STAND_SECS } from '../src/node/load';
import type { StoreSupervisor } from '../src/node/supervisor';
import { Suspensions, outboxEmpty } from '../src/node/suspension';
import { newHolderId } from '../src/state/leases';
import { type LedgerHandle, LedgerConflict, PgLedgerStore } from '../src/state/ledger-store';
import { submitRequest } from './helpers/node-requests';
import {
  D,
  WEBHOOK_SECRET,
  NOW,
  sellingLedger,
  key,
  lease,
  orderWraps,
  publishedStore,
  seedStore,
  storeStatus,
  storedLedger,
  testHeal,
  testSetupDeps,
  testSupervisor,
  vault,
  waitFor,
} from './helpers/node-store';
import { RelayWorld } from './helpers/node-world';
import { freshDb } from './pglite-db';

const HOOK_URL = 'https://shop.example.com/hook';

const supervisors: StoreSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
});

async function suspendingSince(db: Db, owner: string): Promise<number | null | undefined> {
  const [row] = await db.query<{ suspending_since: number | null }>(
    'select suspending_since from stores where owner = $1',
    [owner],
  );
  return row?.suspending_since;
}

/**
 * `Suspensions` over a stand-in supervisor whose control tasks get `handleFor`
 * (the real one opens a fresh handle under its lease).
 */
function suspensions(
  db: Db,
  world: RelayWorld,
  owner: string,
  handleFor: () => Promise<LedgerHandle>,
  clock: () => number = () => NOW,
): Suspensions {
  return new Suspensions({
    db,
    supervisor: {
      leased: [owner],
      applyControl: async (_owner, task) => task(await handleFor()),
    },
    setup: testSetupDeps(db, vault(), world, { now: clock }),
    log: () => undefined,
    now: clock,
  });
}

describe('suspension: the guards', () => {
  it("enters suspending only under this run's lease: a lost lease changes nothing", async () => {
    const db = await freshDb();
    const keys = vault();
    const { owner } = await seedStore(db, keys);
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const id = await submitRequest(db, owner.pubkey, 'suspend', {}, NOW);
    const stale = () =>
      new PgLedgerStore(db, () => NOW).open(owner.pubkey, (leased?.epoch ?? 0) + 1, holder);
    await expect(
      suspensions(db, new RelayWorld(), owner.pubkey, stale).applyRequest(owner.pubkey, id),
    ).rejects.toThrow(LedgerConflict);
    expect(await storeStatus(db, owner.pubkey)).toBe('active');
    expect((await getRequest(db, owner.pubkey, id))?.state).toBe('pending');
  });

  it('suspends only when the fresh ledger still has an empty outbox', async () => {
    const db = await freshDb();
    const keys = vault();
    const { owner } = await seedStore(db, keys, { status: 'suspending', state: emptyLedger() });
    const since = NOW - TERMS_STAND_SECS - 10;
    await db.query('update stores set suspending_since = $2 where owner = $1', [
      owner.pubkey,
      since,
    ]);
    const holder = newHolderId();
    const [leased] = await lease(db, holder);
    const open = () =>
      new PgLedgerStore(db, () => NOW).open(owner.pubkey, leased?.epoch ?? 0, holder);
    // The row read by the tick shows an empty outbox; the node queued a webhook since.
    const busy = async () => {
      const handle = await open();
      handle.state.orders.x = {
        webhook: {
          state: 'pending',
          eventId: 'e',
          createdAt: NOW,
          deadline: NOW + 60,
          attempts: 0,
          nextAt: NOW,
        },
      } as unknown as (typeof handle.state.orders)[string];
      return handle;
    };
    expect(await suspensions(db, new RelayWorld(), owner.pubkey, busy).tick()).toEqual([]);
    expect(await storeStatus(db, owner.pubkey)).toBe('suspending');
    expect(await suspensions(db, new RelayWorld(), owner.pubkey, open).tick()).toEqual([
      owner.pubkey,
    ]);
    expect(await storeStatus(db, owner.pubkey)).toBe('suspended');
  });

  it('with no payout list committed, starts the clock only when no terms stand', async () => {
    for (const [state, starts] of [
      [emptyLedger(), true],
      [sellingLedger(), false],
    ] as const) {
      const db = await freshDb();
      const keys = vault();
      const world = new RelayWorld();
      const { owner } = await seedStore(db, keys, { status: 'suspending', state });
      const holder = newHolderId();
      const [leased] = await lease(db, holder);
      const open = () =>
        new PgLedgerStore(db, () => NOW).open(owner.pubkey, leased?.epoch ?? 0, holder);
      await suspensions(db, world, owner.pubkey, open).tick();
      expect(world.events).toEqual([]);
      expect(await suspendingSince(db, owner.pubkey)).toBe(starts ? NOW : null);
    }
  });
});

describe('suspension (step 15)', () => {
  it('starts no countdown while a sold-out listing reached no relay, and retries the pass with backoff', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    await seedStore(db, keys, seed);
    const owner = seed.owner.pubkey;
    let clock = NOW;
    const holder = newHolderId();
    const { heal } = testHeal(db, keys, world);
    const { supervisor } = testSupervisor(db, keys, holder, world, chain({}).rpc, {
      heal,
      now: () => clock,
    });
    supervisors.push(supervisor);
    const requests = new HolderRequests({
      db,
      supervisor,
      setup: testSetupDeps(db, keys, world, { now: () => clock }),
    });
    supervisor.reconcile(await lease(db, holder));
    await supervisor.idle();
    let refusing = true;
    let listingAttempts = 0;
    world.refuse = (event) => {
      if (event.kind !== 30402) {
        return false;
      }
      listingAttempts += 1;
      return refusing;
    };
    const id = await submitRequest(db, owner, 'suspend', {}, NOW);

    await requests.drain(owner);
    expect((await getRequest(db, owner, id))?.state).toBe('applied');
    expect(await storeStatus(db, owner)).toBe('suspending');
    expect(await suspendingSince(db, owner)).toBeNull();
    const kept = await storedLedger(db, owner);
    expect(kept.listings[D]?.eventId).toBe(seed.state?.listings[D]?.eventId);
    expect(kept.terms.some((period) => period.terms.d === D && period.until === undefined)).toBe(
      true,
    );
    const firstAttempts = listingAttempts;
    expect(firstAttempts).toBeGreaterThan(0);
    expect(supervisor.running).toEqual([owner]);

    await requests.suspensions.tick();
    expect(listingAttempts).toBe(firstAttempts);

    clock += 30;
    await requests.suspensions.tick();
    expect(listingAttempts).toBeGreaterThan(firstAttempts);
    expect(await suspendingSince(db, owner)).toBeNull();

    refusing = false;
    clock += 60;
    await requests.suspensions.tick();
    expect(await suspendingSince(db, owner)).toBe(clock);
    const sold = await storedLedger(db, owner);
    expect(sold.listings[D]?.eventId).not.toBe(kept.listings[D]?.eventId);
    expect(sold.terms.every((period) => period.until !== undefined)).toBe(true);
    const listing = world.events.find((event) => event.id === sold.listings[D]?.eventId);
    expect(listing?.tags).toContainEqual(['visibility', 'sold-out']);
    expect(await storeStatus(db, owner)).toBe('suspending');
  });

  it('keeps intake and sweep for the order lifetime: an order paid in time completes, one placed after is refused, suspended once the outbox is empty', async () => {
    const world = new RelayWorld();
    const seed = await publishedStore(world);
    const db = await freshDb();
    const keys = vault();
    const buyer = key();
    const before = orderWraps(
      seed.store,
      buyer,
      'b3a7c2d4-0000-4000-8000-00000000c001',
      signatureOf(11),
      NOW - 4000,
    );
    const after = orderWraps(
      seed.store,
      buyer,
      'b3a7c2d4-0000-4000-8000-00000000c002',
      signatureOf(12),
      NOW - 120,
    );
    const { rpc } = chain({
      [signatureOf(11)]: await landedPayment(requestFor(before.reference), {
        blockTime: NOW - 3500,
      }),
      [signatureOf(12)]: await landedPayment(requestFor(after.reference), {
        blockTime: NOW - 60,
      }),
    });
    await seedStore(db, keys, { ...seed, webhookUrl: HOOK_URL, webhookSecret: WEBHOOK_SECRET });
    const owner = seed.owner.pubkey;
    let clock = NOW - 3600;
    let answer = 500;
    const sends: string[] = [];
    const holder = newHolderId();
    const { heal } = testHeal(db, keys, world);
    const { supervisor } = testSupervisor(db, keys, holder, world, rpc, {
      heal,
      now: () => clock,
      webhookSlots: {
        forStore: () => async (url) => {
          sends.push(url);
          return new Response(null, { status: answer });
        },
      },
    });
    supervisors.push(supervisor);
    const requests = new HolderRequests({
      db,
      supervisor,
      setup: testSetupDeps(db, keys, world, { now: () => clock }),
    });
    supervisor.reconcile(await lease(db, holder, clock));
    await supervisor.idle();
    await submitRequest(db, owner, 'suspend', {}, clock);
    await requests.drain(owner);
    const since = NOW - 3600;
    expect(await suspendingSince(db, owner)).toBe(since);

    clock = NOW;
    for (const wraps of [before, after]) {
      world.deliver(wraps.order);
      world.deliver(wraps.receipt);
    }
    await waitFor(
      async () => (await storedLedger(db, owner)).orders[before.key]?.deliveredAt !== undefined,
      'the order placed before the suspension completed',
    );
    await waitFor(
      async () =>
        (await storedLedger(db, owner)).orders[after.key]?.refusedTxs?.includes(signatureOf(12)) ===
        true,
      'the payment of the order placed after refused',
    );
    const stored = await storedLedger(db, owner);
    expect(stored.orders[after.key]?.paid).toBeUndefined();
    await waitFor(() => sends.length > 0, 'a webhook attempt');
    expect(outboxEmpty(await storedLedger(db, owner), clock)).toBe(false);

    expect(await requests.suspensions.tick()).toEqual([]);
    clock = since + TERMS_STAND_SECS + 1;
    expect(await requests.suspensions.tick()).toEqual([]);
    expect(await storeStatus(db, owner)).toBe('suspending');

    answer = 200;
    await waitFor(
      async () => (await storedLedger(db, owner)).orders[before.key]?.webhook?.state === 'sent',
      'the webhook sent',
      15_000,
    );
    expect(await requests.suspensions.tick()).toEqual([owner]);
    expect(await storeStatus(db, owner)).toBe('suspended');
    await supervisor.idle();
    expect(supervisor.running).toEqual([]);
    expect(supervisor.leased).toEqual([]);
    const [leaseRow] = await db.query<{ expires_at: number }>(
      'select expires_at from leases where owner = $1',
      [owner],
    );
    expect(leaseRow?.expires_at).toBe(0);
  }, 30_000);

  it('counts a pending webhook past its deadline as done', () => {
    const order = {
      webhook: {
        state: 'pending' as const,
        eventId: 'e',
        createdAt: NOW,
        deadline: NOW + 10,
        attempts: 1,
        nextAt: NOW,
      },
    };
    const state = { orders: { a: order } } as unknown as Parameters<typeof outboxEmpty>[0];
    expect(outboxEmpty(state, NOW)).toBe(false);
    expect(outboxEmpty(state, NOW + 10)).toBe(true);
  });
});
