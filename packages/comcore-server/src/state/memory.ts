import { SESSION_END_MARGIN_SECS, SESSION_TTL_SECS } from '@elisym/comcore';
import Decimal from 'decimal.js-light';
import type { NostrEvent } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { RUMOR_DEDUP_SECS } from '../constants';
import type { AskRecord, ServerState, SessionState, StoreRecord } from './types';

const SECS_PER_DAY = 24 * 60 * 60;

interface Reservation {
  owner: string;
  day: number;
  amount: Decimal;
}

interface StoreDay {
  spent: Decimal;
  reserved: Decimal;
}

function utcDay(now: number): number {
  return Math.floor(now / SECS_PER_DAY);
}

function sessionKey(assistant: string, visitor: string): string {
  return `${assistant}:${visitor}`;
}

function newAttemptId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The server state in memory (phase 2). Every method is one synchronous step,
 * which is what a transaction gives the Postgres version (phase 3).
 */
export class MemoryState implements ServerState {
  private readonly byOwner = new Map<string, StoreRecord>();
  private readonly byAssistant = new Map<string, StoreRecord>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly asks = new Map<string, Map<string, AskRecord>>();
  private readonly rumors = new Map<string, number>();
  private readonly storeDays = new Map<string, StoreDay>();
  private readonly sessionDays = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly clicks = new Map<string, number>();

  constructor(stores: readonly StoreRecord[]) {
    for (const store of stores) {
      this.byOwner.set(store.owner, store);
      this.byAssistant.set(getPublicKey(store.assistantSecretKey), store);
    }
  }

  stores(): StoreRecord[] {
    return [...this.byOwner.values()];
  }

  store(owner: string): StoreRecord | undefined {
    return this.byOwner.get(owner);
  }

  storeByAssistant(assistant: string): StoreRecord | undefined {
    return this.byAssistant.get(assistant);
  }

  session(assistant: string, visitor: string, now: number): SessionState {
    const key = sessionKey(assistant, visitor);
    const existing = this.sessions.get(key);
    if (existing && existing.sessionEnd - now > SESSION_END_MARGIN_SECS) {
      return existing;
    }
    // A session ends 24 h after its first message and is deleted with its history (5.8).
    this.asks.delete(key);
    const fresh: SessionState = {
      assistant,
      visitor,
      sessionEnd: now + SESSION_TTL_SECS,
      history: [],
      visitorMessages: [],
      policyPassages: [],
      allowedIds: [],
    };
    this.sessions.set(key, fresh);
    return fresh;
  }

  saveSession(session: SessionState): void {
    this.sessions.set(sessionKey(session.assistant, session.visitor), session);
  }

  firstSighting(rumorId: string, now: number): boolean {
    for (const [id, expiresAt] of this.rumors) {
      if (expiresAt <= now) {
        this.rumors.delete(id);
      }
    }
    if (this.rumors.has(rumorId)) {
      return false;
    }
    this.rumors.set(rumorId, now + RUMOR_DEDUP_SECS);
    return true;
  }

  askRecord(session: SessionState, askId: string): AskRecord | undefined {
    return this.asks.get(sessionKey(session.assistant, session.visitor))?.get(askId);
  }

  private records(session: SessionState): Map<string, AskRecord> {
    const key = sessionKey(session.assistant, session.visitor);
    const existing = this.asks.get(key);
    if (existing) {
      return existing;
    }
    const created = new Map<string, AskRecord>();
    this.asks.set(key, created);
    return created;
  }

  private storeDay(owner: string, now: number): StoreDay {
    const key = `${owner}:${utcDay(now)}`;
    const existing = this.storeDays.get(key);
    if (existing) {
      return existing;
    }
    const created: StoreDay = { spent: new Decimal(0), reserved: new Decimal(0) };
    this.storeDays.set(key, created);
    return created;
  }

  private ownerOf(session: SessionState): StoreRecord | undefined {
    return this.byAssistant.get(session.assistant);
  }

  private reserve(store: StoreRecord, reserveUsd: string, now: number): string | undefined {
    const day = this.storeDay(store.owner, now);
    const amount = new Decimal(reserveUsd);
    if (day.spent.plus(day.reserved).plus(amount).greaterThan(store.tier.dailyBudgetUsd)) {
      return undefined;
    }
    day.reserved = day.reserved.plus(amount);
    const attemptId = newAttemptId();
    this.reservations.set(attemptId, { owner: store.owner, day: utcDay(now), amount });
    return attemptId;
  }

  /** Settle an attempt's reservation to actual spend; a no-op once resolved. */
  private settle(attemptId: string, spentUsd: string | 'reserved'): void {
    const reservation = this.reservations.get(attemptId);
    if (!reservation) {
      return;
    }
    this.reservations.delete(attemptId);
    const day = this.storeDays.get(`${reservation.owner}:${reservation.day}`);
    if (!day) {
      return;
    }
    day.reserved = day.reserved.minus(reservation.amount);
    day.spent = day.spent.plus(spentUsd === 'reserved' ? reservation.amount : spentUsd);
  }

  private release(attemptId: string): void {
    this.settle(attemptId, '0');
  }

  admitAsk(
    session: SessionState,
    askId: string,
    reserveUsd: string,
    now: number,
  ): { admitted: true; record: AskRecord } | { admitted: false; reason: 'quota' | 'budget' } {
    const store = this.ownerOf(session);
    if (!store || store.status !== 'active') {
      return { admitted: false, reason: 'budget' };
    }
    const quotaKey = `${sessionKey(session.assistant, session.visitor)}:${utcDay(now)}`;
    const used = this.sessionDays.get(quotaKey) ?? 0;
    if (used >= store.tier.messagesPerSessionPerDay) {
      return { admitted: false, reason: 'quota' };
    }
    const attemptId = this.reserve(store, reserveUsd, now);
    if (attemptId === undefined) {
      return { admitted: false, reason: 'budget' };
    }
    this.sessionDays.set(quotaKey, used + 1);
    const record: AskRecord = { state: 'queued', attemptId, deadline: 0 };
    this.records(session).set(askId, record);
    return { admitted: true, record };
  }

  retryAsk(
    session: SessionState,
    askId: string,
    reserveUsd: string,
    now: number,
  ): { admitted: true; record: AskRecord } | { admitted: false; reason: 'budget' } {
    const store = this.ownerOf(session);
    const previous = this.askRecord(session, askId);
    if (!store || store.status !== 'active' || !previous) {
      return { admitted: false, reason: 'budget' };
    }
    const attemptId = this.reserve(store, reserveUsd, now);
    if (attemptId === undefined) {
      return { admitted: false, reason: 'budget' };
    }
    if (previous.state === 'queued') {
      this.release(previous.attemptId);
    } else if (previous.state === 'running') {
      // Real usage is unknown: the superseded attempt is charged in full.
      this.settle(previous.attemptId, 'reserved');
    }
    const record: AskRecord = { state: 'queued', attemptId, deadline: 0 };
    this.records(session).set(askId, record);
    return { admitted: true, record };
  }

  startAsk(session: SessionState, askId: string, attemptId: string, deadline: number): boolean {
    const record = this.askRecord(session, askId);
    if (!record || record.state !== 'queued' || record.attemptId !== attemptId) {
      return false;
    }
    record.state = 'running';
    record.deadline = deadline;
    return true;
  }

  answerAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    answerWrap: NostrEvent,
    spentUsd: string,
    now: number,
  ): boolean {
    const record = this.askRecord(session, askId);
    if (
      !record ||
      record.state !== 'running' ||
      record.attemptId !== attemptId ||
      record.deadline <= now * 1000
    ) {
      return false;
    }
    record.state = 'answered';
    record.answerWrap = answerWrap;
    this.settle(attemptId, spentUsd);
    return true;
  }

  failAsk(session: SessionState, askId: string, attemptId: string, spentUsd: string): boolean {
    const record = this.askRecord(session, askId);
    if (!record || record.state !== 'running' || record.attemptId !== attemptId) {
      return false;
    }
    record.state = 'failed';
    this.settle(attemptId, spentUsd);
    return true;
  }

  budgetExhausted(owner: string, now: number): boolean {
    const store = this.byOwner.get(owner);
    if (!store) {
      return true;
    }
    const day = this.storeDay(owner, now);
    return day.spent.plus(day.reserved).greaterThanOrEqualTo(store.tier.dailyBudgetUsd);
  }

  countClick(owner: string, address: string): void {
    const key = `${owner}:${address}`;
    this.clicks.set(key, (this.clicks.get(key) ?? 0) + 1);
  }

  /** Test and admin view: a store's spend and reservations today. */
  dayTotals(owner: string, now: number): { spent: string; reserved: string } {
    const day = this.storeDay(owner, now);
    return { spent: day.spent.toString(), reserved: day.reserved.toString() };
  }

  clicksFor(owner: string, address: string): number {
    return this.clicks.get(`${owner}:${address}`) ?? 0;
  }
}
