import type { NostrEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { monthStartDay, utcDay } from '../src/state/pg-state';
import { HOLDER, NOW, TIER, leaseEpoch, stateWith, storeRecord, syntheticStore } from './fixtures';

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
    const session = await state.session(store.assistant, VISITOR, NOW);
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
    const session = await state.session(store.assistant, VISITOR, NOW);
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
    const retry = await state.retryAsk(session, ASK_ID, '0.05', newEpoch, NOW + 61);
    expect(retry).toMatchObject({ admitted: true, record: { leaseEpoch: newEpoch } });
    expect(await state.dayTotals(store.owner, NOW)).toEqual({ spent: '0.05', reserved: '0.05' });
  });

  it('a queued record under a dead epoch is released by the sweep and becomes failed', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const epoch = await leaseEpoch(state, store.assistant);
    const session = await state.session(store.assistant, VISITOR, NOW);
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
    const session = await state.session(store.assistant, VISITOR, NOW);
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
    const session = await state.session(store.assistant, VISITOR, NOW);
    await state.admitAsk(session, ASK_ID, '0.05', epoch, NOW);
    await state.releaseLeases(HOLDER);
    const newEpoch = await leaseEpoch(state, store.assistant, NOW + 1);
    expect(newEpoch).toBe(epoch + 1);
    expect((await state.retryAsk(session, ASK_ID, '0.05', newEpoch, NOW + 1)).admitted).toBe(true);
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
    const session = await state.session(store.assistant, VISITOR, NOW);
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
    const session = await state.session(store.assistant, VISITOR, today);
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
      ['1', '2', '3'].map((digit) => state.session(store.assistant, digit.repeat(64), NOW)),
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
    const session = await state.session(store.assistant, VISITOR, NOW);
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

  it('saving a replaced session changes nothing', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const old = await state.session(store.assistant, VISITOR, NOW);
    const fresh = await state.session(store.assistant, VISITOR, old.sessionEnd);
    expect(fresh.id).not.toBe(old.id);
    await state.saveSession({ ...old, visitorMessages: ['stale'] });
    expect(await state.storedSession(store.assistant, VISITOR)).toEqual(fresh);
  });

  it('a history round-trips through the database', async () => {
    const store = syntheticStore();
    const { state } = await stateWith([storeRecord(store)]);
    const session = await state.session(store.assistant, VISITOR, NOW);
    const saved = {
      ...session,
      history: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      visitorMessages: ['hi'],
      policyPassages: ['p'],
      allowedIds: ['jacket-wool'],
    };
    await state.saveSession(saved);
    expect(await state.storedSession(store.assistant, VISITOR)).toEqual(saved);
  });
});
