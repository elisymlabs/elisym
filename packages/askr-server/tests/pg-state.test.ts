import { PGlite } from '@electric-sql/pglite';
import { buildConfigEvent } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ORPHAN_RESERVATION_SECS } from '../src/constants';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { PgState, monthStartDay, utcDay } from '../src/state/pg-state';
import type { StoreDirectory } from '../src/state/stores';
import type { SessionState } from '../src/state/types';
import {
  HOLDER,
  NOW,
  ORIGIN,
  type SyntheticStore,
  TIER,
  leaseEpoch,
  stateWith,
  storeRecord,
  syntheticStore,
} from './fixtures';
import { pgliteDb } from './pglite-db';

const VISITOR = 'b'.repeat(64);
const ASK_ID = 'a'.repeat(32);
const OTHER_ASK = 'c'.repeat(32);
const WRAP: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: 'e'.repeat(64),
  created_at: NOW,
  kind: 1059,
  tags: [],
  content: '',
  sig: '0'.repeat(128),
};
const SECS_PER_DAY = 86_400;

describe('leases (5.8)', () => {
  it('a free active store is leased at epoch 1; renewing keeps the epoch', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const first = await state.acquireLeases(HOLDER, NOW, 60);
    expect(first.map((lease) => [lease.store.owner, lease.epoch])).toEqual([[store.owner, 1]]);
    expect(first[0]?.store.assistantSecretKey).toEqual(store.assistantSecret);
    expect(first[0]?.store.catalogSecretKey).toEqual(store.catalogSecret);
    const renewed = await state.acquireLeases(HOLDER, NOW + 30, 60);
    expect(renewed.map((lease) => lease.epoch)).toEqual([1]);
  });

  it('a live lease of another holder is not taken; an expired one is, with a new epoch', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    await state.acquireLeases('other', NOW, 60);
    expect(await state.acquireLeases(HOLDER, NOW + 59, 60)).toEqual([]);
    const taken = await state.acquireLeases(HOLDER, NOW + 60, 60);
    expect(taken.map((lease) => lease.epoch)).toEqual([2]);
    expect(await state.acquireLeases('other', NOW + 61, 60)).toEqual([]);
  });

  it('my own expired lease is taken again with a new epoch', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    await state.acquireLeases(HOLDER, NOW, 60);
    const again = await state.acquireLeases(HOLDER, NOW + 61, 60);
    expect(again.map((lease) => lease.epoch)).toEqual([2]);
  });

  it('pending and suspended stores are never leased; a store leaving active is given up', async () => {
    const active = syntheticStore();
    const pending = syntheticStore();
    const { state, directory } = await stateWith([
      storeRecord(active),
      { ...storeRecord(pending), status: 'pending' },
    ]);
    expect((await state.acquireLeases(HOLDER, NOW, 60)).map((lease) => lease.store.owner)).toEqual([
      active.owner,
    ]);
    expect(await directory.setStatus(active.owner, 'suspended')).toBe(true);
    expect(await state.acquireLeases(HOLDER, NOW + 1, 60)).toEqual([]);
    // Given up: another holder takes it at once when it is active again, with a new epoch.
    expect(await directory.setStatus(active.owner, 'active')).toBe(true);
    const taken = await state.acquireLeases('other', NOW + 2, 60);
    expect(taken.map((lease) => lease.epoch)).toEqual([2]);
  });

  it('released leases are taken by another holder at once', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    await state.acquireLeases(HOLDER, NOW, 60);
    await state.releaseLeases(HOLDER);
    expect((await state.acquireLeases('other', NOW, 60)).map((lease) => lease.epoch)).toEqual([2]);
  });
});

describe('ask transitions under lease epochs (5.8)', () => {
  it('an attempt of a lost lease cannot start, answer or fail', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    expect(admitted.record.leaseEpoch).toBe(epoch);
    await state.acquireLeases('other', NOW + 61, 60);
    const deadline = (NOW + 61) * 1000 + 60_000;
    expect(await state.startAsk(session, ASK_ID, attemptId, epoch, deadline)).toBe(false);
    expect(await state.startAsk(session, ASK_ID, attemptId, epoch + 1, deadline)).toBe(false);
  });

  it('a running attempt whose lease moved neither answers nor fails; the retry converts it', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    const deadline = NOW * 1000 + 120_000;
    expect(await state.startAsk(session, ASK_ID, attemptId, epoch, deadline)).toBe(true);
    const [taken] = await state.acquireLeases('other', NOW + 61, 60);
    const newEpoch = taken?.epoch ?? 0;
    expect(await state.answerAsk(session, ASK_ID, attemptId, epoch, WRAP, '0.01', NOW + 61)).toBe(
      false,
    );
    expect(await state.failAsk(session, ASK_ID, attemptId, epoch, '0.01')).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
    const retry = await state.retryAsk(session, ASK_ID, attemptId, '0.05', newEpoch, NOW + 61);
    expect(retry).toMatchObject({ admitted: true, record: { leaseEpoch: newEpoch } });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0.05' });
  });

  it('a queued record under a dead epoch is released by the sweep and becomes failed', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).admitted).toBe(true);
    await state.sweep(NOW);
    // Its lease is live: the sweep leaves it.
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'queued' });
    await state.acquireLeases('other', NOW + 61, 60);
    await state.sweep(NOW + 61);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'failed' });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
  });

  it('a running record past its deadline is charged in full by the sweep; its late end changes nothing', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    await state.startAsk(session, ASK_ID, attemptId, epoch, NOW * 1000 + 1_000);
    await state.sweep(NOW);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'running' });
    await state.sweep(NOW + 1);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'failed' });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
    expect(await state.failAsk(session, ASK_ID, attemptId, epoch, '0.01')).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
  });

  it('a retried queued record is not failed by the sweep under its new live epoch', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const first = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!first.admitted) {
      throw new Error('not admitted');
    }
    await state.releaseLeases(HOLDER);
    const newEpoch = await leaseEpoch(state, store.assistant, NOW + 1);
    expect(newEpoch).toBe(epoch + 1);
    expect(
      (await state.retryAsk(session, ASK_ID, first.record.attemptId, '0.05', newEpoch, NOW + 1))
        .admitted,
    ).toBe(true);
    await state.sweep(NOW + 1);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({
      state: 'queued',
      leaseEpoch: newEpoch,
    });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
  });

  it('an answered ask stores the exact wrap', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    await state.startAsk(session, ASK_ID, attemptId, epoch, NOW * 1000 + 60_000);
    expect(await state.answerAsk(session, ASK_ID, attemptId, epoch, WRAP, '0.02', NOW)).toBe(true);
    expect(await state.askRecord(session, ASK_ID)).toEqual({
      state: 'answered',
      attemptId,
      leaseEpoch: epoch,
      deadline: NOW * 1000 + 60_000,
      answerWrap: WRAP,
    });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.02', reserved: '0' });
  });
});

describe('budgets (5.8)', () => {
  it('the monthly budget refuses what the daily one would allow, counting earlier days of the month', async () => {
    const store = syntheticStore();
    const today = Math.max(utcDay(NOW), monthStartDay(NOW) + 1) * SECS_PER_DAY + 3_600;
    const { state, db } = await stateWith(
      [{ ...storeRecord(store), tier: { ...TIER, dailyBudgetUsd: '1', monthlyBudgetUsd: '1.5' } }],
      today,
    );
    await db.query('insert into store_days (owner, day, spent, reserved) values ($1, $2, $3, 0)', [
      store.owner,
      utcDay(today) - 1,
      '1',
    ]);
    // A previous month never counts.
    await db.query('insert into store_days (owner, day, spent, reserved) values ($1, $2, $3, 0)', [
      store.owner,
      monthStartDay(today) - 1,
      '50',
    ]);
    const epoch = await leaseEpoch(state, store.assistant, today);
    const session = await state.session(store.owner, store.assistant, VISITOR, today);
    expect(await state.budgetExhausted(store.owner, today, '0.5')).toBe(false);
    expect((await state.admitAsk(session, ASK_ID, '0.5', epoch, today)).admitted).toBe(true);
    expect(await state.budgetExhausted(store.owner, today, '0.01')).toBe(true);
    expect(await state.admitAsk(session, OTHER_ASK, '0.01', epoch, today)).toEqual({
      admitted: false,
      reason: 'budget',
    });
  });

  it('a store without a tier is exhausted, and a missing store too', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    expect(await state.budgetExhausted('9'.repeat(64), NOW, '0.01')).toBe(true);
  });

  it('two admissions at once never reserve past the budget', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([
      { ...storeRecord(store), tier: { ...TIER, dailyBudgetUsd: '0.1' } },
    ]);
    const epoch = await leaseEpoch(state, store.assistant);
    const sessions = await Promise.all(
      ['1', '2', '3'].map((digit) =>
        state.session(store.owner, store.assistant, digit.repeat(64), NOW),
      ),
    );
    const results = await Promise.all(
      sessions.map((session) => state.admitAsk(session, ASK_ID, '0.04', epoch, NOW)),
    );
    expect(results.filter((result) => result.admitted)).toHaveLength(2);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.08' });
  });
});

describe('dedup and sessions (5.8)', () => {
  it('a rumor id is recorded once within its TTL, and again after it', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const [first, second] = await Promise.all([
      state.recordRumor('r1', NOW),
      state.recordRumor('r1', NOW),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    expect(await state.rumorSeen('r1', NOW + 10)).toBe(true);
    expect(await state.rumorSeen('r1', NOW + 86_400)).toBe(false);
    expect(await state.recordRumor('r1', NOW + 86_400)).toBe(true);
    await state.sweep(NOW + 86_400);
    expect(await state.rumorSeen('r1', NOW + 86_401)).toBe(true);
  });

  it('a session ended by the sweep takes its asks; a running one is settled by its turn', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    const deadline = (session.sessionEnd + 100) * 1000;
    await state.startAsk(session, ASK_ID, attemptId, epoch, deadline);
    await state.acquireLeases(HOLDER, session.sessionEnd, 60);
    await state.sweep(session.sessionEnd);
    expect(await state.storedSession(store.assistant, VISITOR)).toBeUndefined();
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
    expect(await state.failAsk(session, ASK_ID, attemptId, epoch, '0.01')).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.01', reserved: '0' });
  });

  it('an answer on a replaced session stores nothing', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const old = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const attemptId = await runningAttempt(state, old, ASK_ID, epoch, (NOW + 600) * 1000);
    const fresh = await state.session(store.owner, store.assistant, VISITOR, old.sessionEnd);
    expect(fresh.id).not.toBe(old.id);
    const stale = { ...old, visitorMessages: ['stale'] };
    expect(await state.answerAsk(stale, ASK_ID, attemptId, epoch, WRAP, '0.01', NOW)).toBe(false);
    expect(await state.storedSession(store.assistant, VISITOR)).toEqual(fresh);
  });

  it('a history round-trips through the database', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const attemptId = await runningAttempt(state, session, ASK_ID, epoch, (NOW + 600) * 1000);
    const saved = {
      ...session,
      history: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      visitorMessages: ['hi'],
      policyPassages: ['p'],
      allowedIds: ['jacket-wool'],
    };
    expect(await state.answerAsk(saved, ASK_ID, attemptId, epoch, WRAP, '0.01', NOW)).toBe(true);
    expect(await state.storedSession(store.assistant, VISITOR)).toEqual(saved);
  });
});

/** Admit and start an ask as `HOLDER`; returns the attempt id. */
async function runningAttempt(
  state: PgState,
  session: SessionState,
  askId: string,
  epoch: number,
  deadline: number,
): Promise<string> {
  const admitted = await state.admitAsk(session, askId, '0.05', epoch, NOW);
  if (!admitted.admitted) {
    throw new Error('not admitted');
  }
  expect(await state.startAsk(session, askId, admitted.record.attemptId, epoch, deadline)).toBe(
    true,
  );
  return admitted.record.attemptId;
}

/** O signs a config naming `assistant`, stores it and the relay accepts it: the rotation completes (1.5). */
async function rotateTo(directory: StoreDirectory, store: SyntheticStore, assistant: string) {
  const config = finalizeEvent(
    buildConfigEvent(
      {
        assistant,
        origins: [ORIGIN],
        name: 'Example Shop',
        language: 'en',
        currency: 'USD',
        source: { kind: 'catalog' },
        catalogKey: store.catalogKey,
        createdAt: NOW,
      },
      store.ownerSecret,
    ),
    store.ownerSecret,
  );
  expect(await directory.addEvents(store.owner, [config])).toEqual({ ok: true });
  await directory.markPublished(config.id);
}

describe('server core review: admission under lease handover (5.8)', () => {
  it('a holder whose epoch moved on cannot admit, and a stale admit never overwrites the live record', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const stale = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const [taken] = await state.acquireLeases('other', NOW + 61, 60);
    const current = taken?.epoch ?? 0;
    expect(await state.admitAsk(session, ASK_ID, '0.05', stale, NOW)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    expect(await state.askRecord(session, ASK_ID)).toBeUndefined();
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
    // The current holder runs the ask; a resend read by the stale holder changes nothing.
    const admitted = await state.admitAsk(session, ASK_ID, '0.05', current, NOW);
    if (!admitted.admitted) {
      throw new Error('not admitted');
    }
    const { attemptId } = admitted.record;
    await state.startAsk(session, ASK_ID, attemptId, current, NOW * 1000 + 120_000);
    expect((await state.admitAsk(session, ASK_ID, '0.05', stale, NOW)).admitted).toBe(false);
    expect(await state.answerAsk(session, ASK_ID, attemptId, current, WRAP, '0.01', NOW)).toBe(
      true,
    );
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.01', reserved: '0' });
  });

  it('admitting an ask that already has a record is superseded and keeps that record', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const attemptId = await runningAttempt(state, session, ASK_ID, epoch, NOW * 1000 + 120_000);
    expect(await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'running', attemptId });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
  });

  it('a retry by a stale epoch, of another attempt, or of a live record is superseded', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const stale = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const first = await runningAttempt(state, session, ASK_ID, stale, (NOW + 600) * 1000);
    const [taken] = await state.acquireLeases('other', NOW + 61, 60);
    const current = taken?.epoch ?? 0;
    const later = NOW + 61;
    expect(await state.retryAsk(session, ASK_ID, first, '0.05', stale, later)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    expect(
      (await state.retryAsk(session, ASK_ID, 'f'.repeat(32), '0.05', current, later)).admitted,
    ).toBe(false);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
    const retry = await state.retryAsk(session, ASK_ID, first, '0.05', current, later);
    if (!retry.admitted) {
      throw new Error('not retried');
    }
    const second = retry.record.attemptId;
    expect(await state.startAsk(session, ASK_ID, second, current, (later + 120) * 1000)).toBe(true);
    // Live under the current epoch before its deadline: a second resend does not take it over.
    expect(await state.retryAsk(session, ASK_ID, second, '0.05', current, later)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    // The stale holder reads that live record of the new epoch and must not take it over either.
    expect(await state.retryAsk(session, ASK_ID, second, '0.05', stale, later)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ attemptId: second });
    // The first attempt was converted in full once; only the second one is held.
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0.05' });
  });

  it('the sweep charges a reservation no ask references once it is past the turn deadline and margin', async () => {
    const store = syntheticStore();
    const { state, db } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).admitted).toBe(true);
    // An ask record lost by some future bug: its reservation would otherwise be held all day.
    await db.query('delete from asks where session_id = $1', [session.id]);
    await leaseEpoch(state, store.assistant, NOW + ORPHAN_RESERVATION_SECS - 1);
    await state.sweep(NOW + ORPHAN_RESERVATION_SECS - 1);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0.05' });
    await state.sweep(NOW + ORPHAN_RESERVATION_SECS);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0' });
  });
});

describe('server core review: rotation, suspension and counters (5.8)', () => {
  it('a turn running while A rotates still answers and settles', async () => {
    const store = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const attemptId = await runningAttempt(state, session, ASK_ID, epoch, NOW * 1000 + 120_000);
    const next = await directory.beginRotation(store.owner);
    if (next === undefined) {
      throw new Error('no rotation');
    }
    await rotateTo(directory, store, next);
    expect((await state.store(store.owner))?.assistant).toBe(next);
    expect(await state.answerAsk(session, ASK_ID, attemptId, epoch, WRAP, '0.01', NOW)).toBe(true);
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.01', reserved: '0' });
  });

  it("the sweep resolves the old A's queued attempt once its lease moved", async () => {
    const store = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).admitted).toBe(true);
    const next = await directory.beginRotation(store.owner);
    if (next === undefined) {
      throw new Error('no rotation');
    }
    await rotateTo(directory, store, next);
    await state.acquireLeases('other', NOW + 61, 60);
    await state.sweep(NOW + 61);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'failed' });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
  });

  it("a suspended store's queued attempt is released by the next sweep", async () => {
    const store = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).admitted).toBe(true);
    expect(await directory.setStatus(store.owner, 'suspended')).toBe(true);
    // The holder gives the lease up (expiry 0); nobody takes it, so the epoch stays.
    expect(await state.acquireLeases(HOLDER, NOW + 1, 60)).toEqual([]);
    await state.sweep(NOW + 1);
    expect(await state.askRecord(session, ASK_ID)).toMatchObject({ state: 'failed' });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
  });

  it('refuses an ask for a store that is not active, reserving nothing', async () => {
    const store = syntheticStore();
    const { state, db } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    // The lease is still current: only the store's state refuses.
    await db.query(`update stores set status = 'suspended' where owner = $1`, [store.owner]);
    expect(await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW)).toEqual({
      admitted: false,
      reason: 'budget',
    });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
  });

  it('the per-session quota still holds after a sweep on the same day', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([
      { ...storeRecord(store), tier: { ...TIER, messagesPerSessionPerDay: 1 } },
    ]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect((await state.admitAsk(session, ASK_ID, '0.01', epoch, NOW)).admitted).toBe(true);
    await state.sweep(NOW);
    expect(await state.admitAsk(session, OTHER_ASK, '0.01', epoch, NOW)).toEqual({
      admitted: false,
      reason: 'quota',
    });
  });

  it('spend on the first day of the month counts toward the monthly budget', async () => {
    const store = syntheticStore();
    const today = (monthStartDay(NOW) + 1) * SECS_PER_DAY + 3_600;
    const { state, db } = await stateWith(
      [{ ...storeRecord(store), tier: { ...TIER, dailyBudgetUsd: '1', monthlyBudgetUsd: '1.5' } }],
      today,
    );
    await db.query('insert into store_days (owner, day, spent, reserved) values ($1, $2, $3, 0)', [
      store.owner,
      monthStartDay(today),
      '1',
    ]);
    const epoch = await leaseEpoch(state, store.assistant, today);
    const session = await state.session(store.owner, store.assistant, VISITOR, today);
    expect(await state.admitAsk(session, ASK_ID, '0.6', epoch, today)).toEqual({
      admitted: false,
      reason: 'budget',
    });
    expect((await state.admitAsk(session, ASK_ID, '0.5', epoch, today)).admitted).toBe(true);
  });

  it('admitting on a replaced session is refused without reserving', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const old = await state.session(store.owner, store.assistant, VISITOR, NOW);
    await state.session(store.owner, store.assistant, VISITOR, old.sessionEnd);
    expect(await state.admitAsk(old, ASK_ID, '0.05', epoch, NOW)).toEqual({
      admitted: false,
      reason: 'superseded',
    });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0', reserved: '0' });
  });

  it('a store whose sealed key does not open is skipped; the others are leased', async () => {
    const broken = syntheticStore();
    const fine = syntheticStore();
    const { db, vault } = await stateWith([storeRecord(broken), storeRecord(fine)]);
    await db.query('update stores set assistant_key = $2 where owner = $1', [
      broken.owner,
      vault.seal(generateSecretKey(), 'f'.repeat(64), 'assistant'),
    ]);
    const logs: string[] = [];
    const state = new PgState(db, vault, (message) => logs.push(message));
    const leases = await state.acquireLeases(HOLDER, NOW, 60);
    expect(leases.map((lease) => lease.store.owner)).toEqual([fine.owner]);
    expect(logs).toEqual([expect.stringContaining(`store ${broken.owner} skipped`)]);
  });

  it('an answer stores the session history in the same step; a superseded one stores nothing', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const attemptId = await runningAttempt(state, session, ASK_ID, epoch, NOW * 1000 + 120_000);
    const late = { ...session, visitorMessages: ['late'] };
    expect(await state.answerAsk(late, ASK_ID, 'f'.repeat(32), epoch, WRAP, '0', NOW)).toBe(false);
    expect((await state.storedSession(store.assistant, VISITOR))?.visitorMessages).toEqual([]);
    const answered = { ...session, visitorMessages: ['something warm?'] };
    expect(await state.answerAsk(answered, ASK_ID, attemptId, epoch, WRAP, '0.01', NOW)).toBe(true);
    expect((await state.storedSession(store.assistant, VISITOR))?.visitorMessages).toEqual([
      'something warm?',
    ]);
  });
});

describe('conversation count (7.3)', () => {
  const conversations = async (directory: StoreDirectory, store: SyntheticStore) =>
    (await directory.usage(store.owner, store.assistant, NOW)).conversations;

  it('counts a session once, on its first answered turn, however many follow', async () => {
    const store = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    expect(await conversations(directory, store)).toBe(0);
    const first = await runningAttempt(state, session, ASK_ID, epoch, NOW * 1000 + 120_000);
    expect(await state.answerAsk(session, ASK_ID, first, epoch, WRAP, '0.01', NOW)).toBe(true);
    expect(await conversations(directory, store)).toBe(1);
    // The same answer again is no transition and no count.
    expect(await state.answerAsk(session, ASK_ID, first, epoch, WRAP, '0.01', NOW)).toBe(false);
    const second = await runningAttempt(state, session, OTHER_ASK, epoch, NOW * 1000 + 120_000);
    expect(await state.answerAsk(session, OTHER_ASK, second, epoch, WRAP, '0.01', NOW)).toBe(true);
    expect(await conversations(directory, store)).toBe(1);
  });

  it('does not count a session whose turns all failed, nor one with no turn', async () => {
    const store = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    await state.session(store.owner, store.assistant, 'd'.repeat(64), NOW);
    const attemptId = await runningAttempt(state, session, ASK_ID, epoch, NOW * 1000 + 120_000);
    expect(await state.failAsk(session, ASK_ID, attemptId, epoch, '0.01')).toBe(true);
    expect(await conversations(directory, store)).toBe(0);
  });

  it('a turn retried after its lease moved counts once, by the attempt that answers', async () => {
    const store = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.owner, store.assistant, VISITOR, NOW);
    const stale = await runningAttempt(state, session, ASK_ID, epoch, NOW * 1000 + 120_000);
    const [taken] = await state.acquireLeases('other', NOW + 61, 60);
    const newEpoch = taken?.epoch ?? 0;
    expect(await state.answerAsk(session, ASK_ID, stale, epoch, WRAP, '0.01', NOW + 61)).toBe(
      false,
    );
    expect(await conversations(directory, store)).toBe(0);
    const retry = await state.retryAsk(session, ASK_ID, stale, '0.05', newEpoch, NOW + 61);
    if (!retry.admitted) {
      throw new Error('not admitted');
    }
    const deadline = (NOW + 61) * 1000 + 120_000;
    const { attemptId } = retry.record;
    expect(await state.startAsk(session, ASK_ID, attemptId, newEpoch, deadline)).toBe(true);
    expect(
      await state.answerAsk(session, ASK_ID, attemptId, newEpoch, WRAP, '0.01', NOW + 62),
    ).toBe(true);
    // The superseded attempt finishing late changes nothing.
    expect(await state.answerAsk(session, ASK_ID, stale, epoch, WRAP, '0.01', NOW + 62)).toBe(
      false,
    );
    expect(await conversations(directory, store)).toBe(1);
  });

  it("a visitor's next session is another conversation, and each store counts its own", async () => {
    const store = syntheticStore();
    const neighbour = syntheticStore();
    const { state, directory } = await stateWith([storeRecord(store), storeRecord(neighbour)]);
    const answerOne = async (now: number) => {
      const epoch = await leaseEpoch(state, store.assistant, now);
      const session = await state.session(store.owner, store.assistant, VISITOR, now);
      const admitted = await state.admitAsk(session, ASK_ID, '0.05', epoch, now);
      if (!admitted.admitted) {
        throw new Error('not admitted');
      }
      const { attemptId } = admitted.record;
      expect(await state.startAsk(session, ASK_ID, attemptId, epoch, now * 1000 + 120_000)).toBe(
        true,
      );
      expect(await state.answerAsk(session, ASK_ID, attemptId, epoch, WRAP, '0.01', now)).toBe(
        true,
      );
    };
    await answerOne(NOW);
    // A day later the session has ended: the same visitor starts a new one.
    await answerOne(NOW + SECS_PER_DAY);
    expect(await conversations(directory, store)).toBe(2);
    expect(await conversations(directory, neighbour)).toBe(0);
  });

  it('the migration counts the sessions already answered when it runs', async () => {
    const client = await PGlite.create();
    const db = pgliteDb(client);
    const [initial] = MIGRATIONS;
    if (initial === undefined) {
      throw new Error('no migrations');
    }
    await db.script(
      `create table migrations (id text primary key, applied_at timestamptz not null default now());
       ${initial.sql}`,
    );
    await db.query('insert into migrations (id) values ($1)', [initial.id]);
    const owner = 'a'.repeat(64);
    const seed = async (id: string, visitor: string, states: string[]) => {
      await db.query(
        `insert into sessions (owner, assistant, visitor, id, session_end, data)
         values ($1, 'e', $2, $3, 0, '{}'::jsonb)`,
        [owner, visitor, id],
      );
      for (const [index, askState] of states.entries()) {
        await db.query(
          `insert into asks (session_id, ask_id, state, attempt_id, lease_epoch, deadline)
           values ($1, $2, $3, $4, 1, 0)`,
          [id, `ask-${index}`, askState, `${id}-${index}`],
        );
      }
    };
    await seed('answered-twice', 'v1', ['answered', 'answered']);
    await seed('answered-once', 'v2', ['failed', 'answered']);
    await seed('never-answered', 'v3', ['failed', 'queued']);
    await migrate(db);
    const [totals] = await db.query<{ conversations: number }>(
      'select conversations from store_totals where owner = $1',
      [owner],
    );
    expect(totals?.conversations).toBe(2);
    const counted = await db.query<{ id: string }>(
      'select id from sessions where counted order by id',
    );
    expect(counted.map((row) => row.id)).toEqual(['answered-once', 'answered-twice']);
    await client.close();
  });
});
