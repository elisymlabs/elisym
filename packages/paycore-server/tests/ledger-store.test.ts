import { type LedgerState, emptyLedger, webhookEventId } from '@merchant-node/ledger';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db';
import { LEASE_TTL_SECS, acquireLeases } from '../src/state/leases';
import {
  LedgerConflict,
  PgLedgerStore,
  RequestNotPending,
  insertLedger,
  parseLedger,
  serializeLedger,
} from '../src/state/ledger-store';
import { freshDb } from './pglite-db';

const NOW = 1_790_000_000;
const OWNER = 'a'.repeat(64);
const STORE = 'b'.repeat(64);
const BUYER = 'c'.repeat(64);
const SOLANA_USDC =
  'solana:EtWTRABZaYq6iMfeYKouRuqf5ac4Q4k1KUDQVYDzcQ3q/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

async function setup(): Promise<{ db: Db; store: PgLedgerStore; clock: { now: number } }> {
  const db = await freshDb();
  await db.query("insert into tiers (name, max_products) values ('basic', 10)");
  await db.query(
    `insert into stores (owner, store_pubkey, status, tier, created_at)
     values ($1, $2, 'active', 'basic', $3)`,
    [OWNER, STORE, NOW],
  );
  await db.transaction((tx) => insertLedger(tx, OWNER, emptyLedger(), NOW));
  const clock = { now: NOW };
  return { db, store: new PgLedgerStore(db, () => clock.now), clock };
}

async function lease(db: Db, holder: string, now: number): Promise<number> {
  const [leased] = await acquireLeases(db, holder, now, LEASE_TTL_SECS);
  if (leased === undefined) {
    throw new Error(`${holder} got no lease`);
  }
  return leased.epoch;
}

async function addRequest(db: Db, id: string): Promise<void> {
  await db.query(
    `insert into admin_requests (id, owner, kind, payload, created_at)
     values ($1, $2, 'hand_answer', '{}', $3)`,
    [id, OWNER, NOW],
  );
}

async function requestRow(db: Db, id: string) {
  const [row] = await db.query<{ state: string; applied_at: number | null }>(
    'select state, applied_at from admin_requests where id = $1',
    [id],
  );
  return row;
}

async function storedState(db: Db): Promise<string> {
  const [row] = await db.query<{ state: string }>('select state from ledgers where owner = $1', [
    OWNER,
  ]);
  if (row === undefined) {
    throw new Error('no ledger row');
  }
  return row.state;
}

/** A v5 ledger using every field a running store writes. */
function v5Ledger(): LedgerState {
  const key = `${BUYER}:order-1`;
  const signature = '5'.repeat(88);
  return {
    version: 5,
    orders: {
      [key]: {
        key,
        buyerPubkey: BUYER,
        orderId: 'order-1',
        rumorId: 'd'.repeat(64),
        createdAt: NOW - 100,
        reference: 'Ref1111111111111111111111111111111111111111',
        email: 'buyer@example.com',
        customerRef: 'acct-42',
        product: `30402:${STORE}:course-101`,
        reportedTxs: [signature, `0x${'e'.repeat(64)}`],
        reportedMedia: { [signature]: 'solana', [`0x${'e'.repeat(64)}`]: 'eip155:4217' },
        refusedTxs: ['6'.repeat(88)],
        noLegTxs: [`0x${'f'.repeat(64)}`],
        tempoNoLeg: [`0x${'1'.repeat(64)}`],
        recheckedAt: { [signature]: NOW - 50 },
        paid: {
          signature,
          amount: '1000000',
          fee: '5000',
          blockTime: NOW - 60,
          caip19: SOLANA_USDC,
          medium: 'solana',
        },
        webhook: {
          state: 'pending',
          eventId: webhookEventId(STORE, key, signature),
          createdAt: NOW - 59,
          deadline: NOW + 86_400,
          attempts: 2,
          nextAt: NOW + 30,
          lastStatus: 503,
          lastError: 'server error',
        },
        deliveredTo: ['wss://relay.elisym.network'],
        deliveredAt: NOW - 58,
      },
      [`${BUYER}:order-2`]: {
        key: `${BUYER}:order-2`,
        buyerPubkey: BUYER,
        orderId: 'order-2',
        rumorId: '2'.repeat(64),
        createdAt: NOW - 10,
        reference: 'Ref2222222222222222222222222222222222222222',
        product: `30402:${STORE}:course-101`,
        reportedTxs: [],
        feeUnresolved: { ['7'.repeat(88)]: NOW - 5 },
        blockedTx: `0x${'3'.repeat(64)}`,
      },
    },
    seenRumors: { ['d'.repeat(64)]: true, ['2'.repeat(64)]: true },
    closedOrders: { [`${BUYER}:old`]: true },
    answeredByHand: {
      [`${BUYER}:old`]: {
        kind: 'refunded',
        tx: '8'.repeat(88),
        amount: '1000000',
        caip19: SOLANA_USDC,
        customerRef: 'acct-41',
        reportedTxs: ['9'.repeat(88)],
        refusedTxs: [],
        noLegTxs: [],
      },
    },
    claims: { [signature]: key },
    terms: [
      {
        terms: { d: 'course-101', caip19: SOLANA_USDC, payout: 'Payout111', amount: '1000000' },
        from: NOW - 1000,
        until: NOW - 500,
      },
      {
        terms: { d: 'course-101', caip19: SOLANA_USDC, payout: 'Payout111', amount: '2000000' },
        from: NOW - 600,
      },
    ],
    resumeAt: NOW - 1,
    scans: { [`Payout111:${signature}`]: { blockTime: NOW - 60, references: ['Ref1'] } },
    listings: {
      'course-101': { hash: 'h'.repeat(64), eventId: 'i'.repeat(64), createdAt: NOW - 600 },
    },
    payto: {
      createdAt: NOW - 2000,
      payouts: JSON.stringify([{ caip19: SOLANA_USDC, address: 'Payout111' }]),
    },
    treasuries: {
      mainnet: {
        solana: { Treasury111: NOW - 100 },
        evm: { [`0x${'4'.repeat(40)}`]: NOW - 100 },
        latest: { solana: 'Treasury111', evm: `0x${'4'.repeat(40)}` },
      },
    },
    unresolvedPayments: [{ key: `${BUYER}:gone`, tx: 'a'.repeat(88), at: NOW - 300 }],
    eip3009Bindings: {
      [`eip155:8453:0x${'5'.repeat(64)}:3`]: {
        state: 'bound',
        txHash: `0x${'5'.repeat(64)}`,
        blockNumber: 123,
        authorizer: `0x${'6'.repeat(40)}`,
        nonce: `0x${'7'.repeat(64)}`,
      },
      [`eip155:8453:0x${'8'.repeat(64)}:1`]: {
        state: 'unbound',
        txHash: `0x${'8'.repeat(64)}`,
        blockNumber: 124,
      },
    },
  };
}

describe('PgLedgerStore', () => {
  it('opens the row and saves after a save, carrying the row version', async () => {
    const { db, store, clock } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    const handle = await store.open(OWNER, epoch, 'h1');
    expect({ owner: handle.owner, epoch: handle.epoch, rowVersion: handle.rowVersion }).toEqual({
      owner: OWNER,
      epoch,
      rowVersion: 1,
    });
    expect(handle.state).toEqual(emptyLedger());
    const state = handle.state;
    state.resumeAt = NOW;
    clock.now = NOW + 5;
    await handle.save(state);
    expect(handle.rowVersion).toBe(2);
    state.resumeAt = NOW + 1;
    await handle.save(state);
    expect(handle.rowVersion).toBe(3);
    const [row] = await db.query('select row_version, lease_epoch, updated_at from ledgers');
    expect(row).toEqual({ row_version: 3, lease_epoch: epoch, updated_at: NOW + 5 });
    expect((await store.open(OWNER, epoch, 'h1')).state.resumeAt).toBe(NOW + 1);
  });

  it("refuses a stale holder's save after a takeover", async () => {
    const { db, store } = await setup();
    const oldEpoch = await lease(db, 'h1', NOW);
    const stale = await store.open(OWNER, oldEpoch, 'h1');
    const newEpoch = await lease(db, 'h2', NOW + LEASE_TTL_SECS);
    expect(newEpoch).toBe(oldEpoch + 1);
    // Even before the new holder saves, the lease check refuses the old one.
    const state = stale.state;
    state.resumeAt = NOW;
    await expect(stale.save(state)).rejects.toBeInstanceOf(LedgerConflict);
    const fresh = await store.open(OWNER, newEpoch, 'h2');
    await fresh.save(fresh.state);
    await expect(stale.save(state)).rejects.toBeInstanceOf(LedgerConflict);
    expect(JSON.parse(await storedState(db)).resumeAt).toBeUndefined();
  });

  it('refuses the old handle of the same holder once it re-acquired the lease after expiry (new epoch)', async () => {
    const { db, store } = await setup();
    const oldEpoch = await lease(db, 'h1', NOW);
    const old = await store.open(OWNER, oldEpoch, 'h1');
    const newEpoch = await lease(db, 'h1', NOW + LEASE_TTL_SECS);
    expect(newEpoch).toBe(oldEpoch + 1);
    const state = old.state;
    state.resumeAt = NOW;
    await expect(old.save(state)).rejects.toBeInstanceOf(LedgerConflict);
    expect(JSON.parse(await storedState(db)).resumeAt).toBeUndefined();
    const fresh = await store.open(OWNER, newEpoch, 'h1');
    await fresh.save(fresh.state);
    expect(fresh.rowVersion).toBe(2);
  });

  it('a save holds the saved state, not the one read', async () => {
    const { db, store } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    const handle = await store.open(OWNER, epoch, 'h1');
    const next = { ...emptyLedger(), resumeAt: NOW + 7 };
    await handle.save(next);
    expect(handle.state).toBe(next);
  });

  it('refuses a save on a row another handle saved since (row_version is the fence)', async () => {
    const { db, store } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    const first = await store.open(OWNER, epoch, 'h1');
    const second = await store.open(OWNER, epoch, 'h1');
    const winner = second.state;
    winner.resumeAt = NOW + 9;
    await second.save(winner);
    const loser = first.state;
    loser.resumeAt = NOW;
    await expect(first.save(loser)).rejects.toThrow(LedgerConflict);
    expect(first.rowVersion).toBe(1);
    expect(JSON.parse(await storedState(db)).resumeAt).toBe(NOW + 9);
  });

  it('refuses a save under the right epoch but another holder', async () => {
    const { db, store } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    const impostor = await store.open(OWNER, epoch, 'h2');
    await expect(impostor.save(impostor.state)).rejects.toBeInstanceOf(LedgerConflict);
  });

  it('marks the applied request in the same transaction, and not on a refused save', async () => {
    const { db, store, clock } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    await addRequest(db, 'req-ok');
    await addRequest(db, 'req-refused');
    const handle = await store.open(OWNER, epoch, 'h1');
    const stale = await store.open(OWNER, epoch, 'h1');
    clock.now = NOW + 3;
    await handle.save(handle.state, { appliedRequest: 'req-ok' });
    expect(await requestRow(db, 'req-ok')).toEqual({ state: 'applied', applied_at: NOW + 3 });
    await expect(stale.save(stale.state, { appliedRequest: 'req-refused' })).rejects.toBeInstanceOf(
      LedgerConflict,
    );
    expect(await requestRow(db, 'req-refused')).toEqual({ state: 'pending', applied_at: null });
  });

  it('a request already applied rolls the save back', async () => {
    const { db, store } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    await addRequest(db, 'req');
    const handle = await store.open(OWNER, epoch, 'h1');
    await handle.save(handle.state, { appliedRequest: 'req' });
    const state = handle.state;
    state.resumeAt = NOW;
    await expect(handle.save(state, { appliedRequest: 'req' })).rejects.toBeInstanceOf(
      RequestNotPending,
    );
    await expect(handle.save(state, { appliedRequest: 'missing' })).rejects.toBeInstanceOf(
      RequestNotPending,
    );
    expect(handle.rowVersion).toBe(2);
    const [row] = await db.query<{ row_version: number }>('select row_version from ledgers');
    expect(row?.row_version).toBe(2);
    expect(JSON.parse(await storedState(db)).resumeAt).toBeUndefined();
    // The handle is still at the row's version: a save without the request goes through.
    await handle.save(state);
    expect(handle.rowVersion).toBe(3);
  });

  it('a request of another store is not marked and rolls the save back', async () => {
    const { db, store } = await setup();
    const otherOwner = 'e'.repeat(64);
    await db.query(
      `insert into stores (owner, store_pubkey, status, tier, created_at)
       values ($1, $2, 'active', 'basic', $3)`,
      [otherOwner, 'f'.repeat(64), NOW],
    );
    await db.query(
      `insert into admin_requests (id, owner, kind, payload, created_at)
       values ('other-req', $1, 'hand_answer', '{}', $2)`,
      [otherOwner, NOW],
    );
    const epoch = await lease(db, 'h1', NOW);
    const handle = await store.open(OWNER, epoch, 'h1');
    const state = handle.state;
    state.resumeAt = NOW;
    await expect(handle.save(state, { appliedRequest: 'other-req' })).rejects.toBeInstanceOf(
      RequestNotPending,
    );
    expect(await requestRow(db, 'other-req')).toEqual({ state: 'pending', applied_at: null });
    expect(handle.rowVersion).toBe(1);
    const [row] = await db.query<{ row_version: number }>(
      'select row_version from ledgers where owner = $1',
      [OWNER],
    );
    expect(row?.row_version).toBe(1);
    expect(JSON.parse(await storedState(db)).resumeAt).toBeUndefined();
  });

  it('refuses a ledger that is not a JSON object', async () => {
    for (const text of ['[]', '[{"version":5}]', 'null', '1', '"ledger"', 'true']) {
      expect(() => parseLedger(text, OWNER)).toThrow('not a JSON object');
    }
    expect(parseLedger('{"version":5}', OWNER)).toEqual({ version: 5 });
    const { db, store } = await setup();
    await db.query("update ledgers set state = '[]' where owner = $1", [OWNER]);
    await expect(store.open(OWNER, 1, 'h1')).rejects.toThrow('not a JSON object');
  });

  it('a v5 ledger round-trips deep-equal', async () => {
    const { db, store } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    const handle = await store.open(OWNER, epoch, 'h1');
    const ledger = v5Ledger();
    await handle.save(ledger);
    expect((await store.open(OWNER, epoch, 'h1')).state).toEqual(v5Ledger());
  });

  it('a NUL and lone surrogates in buyer strings are saved and read back unchanged', async () => {
    const { db, store } = await setup();
    const epoch = await lease(db, 'h1', NOW);
    const handle = await store.open(OWNER, epoch, 'h1');
    const ledger = v5Ledger();
    const orderId = 'id\u0000with\ud800lone\udc00surrogates';
    const key = `${BUYER}:${orderId}`;
    const [order] = Object.values(ledger.orders);
    if (order === undefined) {
      throw new Error('fixture has no order');
    }
    ledger.orders[key] = { ...order, key, orderId, email: 'a\u0000b@\ud800.example' };
    await handle.save(ledger);
    const read = (await store.open(OWNER, epoch, 'h1')).state;
    expect(read).toEqual(ledger);
    expect(read.orders[key]?.orderId).toBe(orderId);
    expect(await storedState(db)).toBe(serializeLedger(ledger));
  });

  it('jsonb would refuse those strings (why `state` is text)', async () => {
    const { db } = await setup();
    for (const text of ['{"a":"\\u0000"}', '{"a":"\\ud800"}']) {
      await expect(db.query('select $1::jsonb', [text])).rejects.toThrow();
    }
  });

  it('opening a store with no ledger row throws', async () => {
    const { store } = await setup();
    await expect(store.open('f'.repeat(64), 1, 'h1')).rejects.toThrow('No ledger');
  });
});
