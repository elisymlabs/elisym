import type { LlmMessage } from '@elisym/comcore-agent';
import type { NostrEvent } from 'nostr-tools';

export type StoreStatus = 'pending' | 'active' | 'suspended';

/** What an operator assigns a store (K18): limits only, no billing. */
export interface Tier {
  /** Asks per session per UTC day. */
  messagesPerSessionPerDay: number;
  /** Spend per store per UTC day, in USD as a decimal string. */
  dailyBudgetUsd: string;
  /** Session tickets per store per minute (3). */
  ticketsPerStorePerMinute: number;
  /** Whether "by ComCore" is shown. */
  branding: boolean;
}

export interface StoreRecord {
  /** O, hex. */
  owner: string;
  status: StoreStatus;
  /** A's secret key; in phase 3 encrypted at rest with the master key. */
  assistantSecretKey: Uint8Array;
  tier: Tier;
}

export interface SessionState {
  assistant: string;
  visitor: string;
  /** Unix seconds: first message + 24 h (4.4). */
  sessionEnd: number;
  history: LlmMessage[];
  visitorMessages: string[];
  policyPassages: string[];
  allowedIds: string[];
}

export type AskState = 'queued' | 'running' | 'answered' | 'failed';

export interface AskRecord {
  state: AskState;
  attemptId: string;
  /** Unix milliseconds; 0 while `queued` (admission and start are one step in phase 2). */
  deadline: number;
  /** The exact answer rumor's wrap, re-published for a repeated `answered` ask (5.8). */
  answerWrap?: NostrEvent;
}

/**
 * The server's state (9). Phase 2 keeps it in memory; phase 3 puts the same
 * interface on Postgres, where each method is one transaction.
 */
export interface ServerState {
  stores(): StoreRecord[];
  store(owner: string): StoreRecord | undefined;
  storeByAssistant(assistant: string): StoreRecord | undefined;
  /**
   * The session for (A, V) at `now`, started at `now` when there is none or
   * when the stored one ends within the end margin (4.4).
   */
  session(assistant: string, visitor: string, now: number): SessionState;
  saveSession(session: SessionState): void;
  /** Whether a rumor id was recorded within its TTL (5.8 dedup). */
  rumorSeen(rumorId: string, now: number): boolean;
  /**
   * Record a rumor id for its TTL. Called only once the ask's ticket checked
   * out, so junk without a valid ticket never fills the dedup set (5.8).
   */
  recordRumor(rumorId: string, now: number): void;
  askRecord(session: SessionState, askId: string): AskRecord | undefined;
  /**
   * Admit a new ask in one step (5.8): the quota and budget check, the
   * reservation and the `queued` record; a refusal writes nothing.
   */
  admitAsk(
    session: SessionState,
    askId: string,
    reserveUsd: string,
    now: number,
  ): { admitted: true; record: AskRecord } | { admitted: false; reason: 'quota' | 'budget' };
  /**
   * Re-run an ask whose record is `failed`, or `queued`/`running` under a dead
   * lease or past its deadline (5.8): in one step check the budget, reserve for
   * a new attempt and resolve what the superseded attempt still holds (`queued`
   * releases it, `running` converts it into spend in full). A retry counts
   * against the session quota like a new ask, so forced failures cannot buy
   * unlimited turns.
   */
  retryAsk(
    session: SessionState,
    askId: string,
    reserveUsd: string,
    now: number,
  ): { admitted: true; record: AskRecord } | { admitted: false; reason: 'quota' | 'budget' };
  /** Conditional transition `queued` (attempt) to `running`; false when superseded. */
  startAsk(session: SessionState, askId: string, attemptId: string, deadline: number): boolean;
  /** Conditional transition `running` (attempt) to `answered`, settling spend to `spentUsd`. */
  answerAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    answerWrap: NostrEvent,
    spentUsd: string,
    now: number,
  ): boolean;
  /** Conditional transition `running` (attempt) to `failed`, settling spend to `spentUsd`. */
  failAsk(session: SessionState, askId: string, attemptId: string, spentUsd: string): boolean;
  /** Whether a store's daily budget is spent (reserved spend counts), so no ticket is issued (3). */
  budgetExhausted(owner: string, now: number): boolean;
  /** Count a handoff click (advisory, 3). */
  countClick(owner: string, address: string): void;
  /**
   * Delete what has ended (5.8, K14): sessions past their end with their
   * history and ask records (resolving what their attempts still hold),
   * expired dedup ids, and past days' quota and spend counters.
   */
  sweep(now: number): void;
}
