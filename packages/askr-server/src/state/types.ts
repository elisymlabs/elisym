import type { LlmMessage } from '@elisym/askr-agent';
import type { NostrEvent } from 'nostr-tools';

export type StoreStatus = 'pending' | 'active' | 'suspended';

/** What an operator assigns a store (K18): limits only, no billing. */
export interface Tier {
  name: string;
  /** Asks per session per UTC day. */
  messagesPerSessionPerDay: number;
  /** Spend per store per UTC day, in USD as a decimal string. */
  dailyBudgetUsd: string;
  /** Spend per store per UTC calendar month, in USD as a decimal string. */
  monthlyBudgetUsd: string;
  /** Session tickets per store per minute (3). */
  ticketsPerStorePerMinute: number;
  /** Products indexed at most (9). */
  maxProducts: number;
  /** How often a connector syncs (7.4). */
  syncIntervalMinutes: number;
  /** Whether "by Askr" is shown. */
  branding: boolean;
}

export interface StoreRecord {
  /** O, hex. */
  owner: string;
  status: StoreStatus;
  /** A, hex. */
  assistant: string;
  /** A's secret key, decrypted from the database with the master key. */
  assistantSecretKey: Uint8Array;
  /** The server K, hex (1.1). */
  catalogKey: string;
  catalogSecretKey: Uint8Array;
  /** Absent only while `pending` (K19). */
  tier: Tier | undefined;
}

/** A store this worker holds the lease on (5.8), with the lease's epoch. */
export interface LeasedStore {
  store: StoreRecord;
  epoch: number;
}

export interface SessionState {
  /** Changes whenever the (A, V) session is replaced, so a stale copy is told apart. */
  id: string;
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
  /** The owner's lease epoch the attempt was admitted under (5.8). */
  leaseEpoch: number;
  /** Unix milliseconds; 0 while `queued` (admission and start follow each other in one worker). */
  deadline: number;
  /** The exact answer rumor's wrap, re-published for a repeated `answered` ask (5.8). */
  answerWrap?: NostrEvent;
}

export type Admission =
  | { admitted: true; record: AskRecord }
  | { admitted: false; reason: 'quota' | 'budget' };

/**
 * The server's state (9) on Postgres; every method is one transaction.
 * Ask transitions are conditional on the attempt id and on the store's lease
 * epoch, so an attempt of a worker that lost its lease changes nothing (5.8).
 */
export interface ServerState {
  store(owner: string): Promise<StoreRecord | undefined>;
  /**
   * Take or renew the leases on active stores that are free, expired or held
   * by `holder`, give up those whose store left `active` (5.8, K19), and
   * return what `holder` holds. A lease taken anew gets a new epoch.
   */
  acquireLeases(holder: string, now: number, ttlSecs: number): Promise<LeasedStore[]>;
  /** Give up every lease `holder` holds (shutdown). */
  releaseLeases(holder: string): Promise<void>;
  /**
   * The session for (A, V) at `now`, started at `now` when there is none or
   * when the stored one ends within the end margin (4.4).
   */
  session(assistant: string, visitor: string, now: number): Promise<SessionState>;
  /** The stored session for (A, V), if any, without starting one. */
  storedSession(assistant: string, visitor: string): Promise<SessionState | undefined>;
  /** Store a session's new history; a no-op when another session has replaced it since. */
  saveSession(session: SessionState): Promise<void>;
  /** Whether a rumor id was recorded within its TTL (5.8 dedup). */
  rumorSeen(rumorId: string, now: number): Promise<boolean>;
  /**
   * Record a rumor id for its TTL; false when it was already recorded within
   * it, so two copies read at once are taken once. Called only once the ask's
   * ticket checked out, so junk without a valid ticket never fills the dedup
   * set (5.8).
   */
  recordRumor(rumorId: string, now: number): Promise<boolean>;
  askRecord(session: SessionState, askId: string): Promise<AskRecord | undefined>;
  /**
   * Admit a new ask in one step (5.8): the quota and budget check, the
   * reservation and the `queued` record; a refusal writes nothing.
   */
  admitAsk(
    session: SessionState,
    askId: string,
    reserveUsd: string,
    epoch: number,
    now: number,
  ): Promise<Admission>;
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
    epoch: number,
    now: number,
  ): Promise<Admission>;
  /** Conditional transition `queued` (attempt, epoch) to `running`; false when superseded. */
  startAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    epoch: number,
    deadline: number,
  ): Promise<boolean>;
  /** Conditional transition `running` (attempt, epoch) to `answered`, settling spend to `spentUsd`. */
  answerAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    epoch: number,
    answerWrap: NostrEvent,
    spentUsd: string,
    now: number,
  ): Promise<boolean>;
  /**
   * Conditional transition `running` (attempt, epoch) to `failed`, settling
   * spend to `spentUsd`. An attempt whose session was replaced meanwhile is
   * settled to `spentUsd` too, and false is returned (nothing to send).
   */
  failAsk(
    session: SessionState,
    askId: string,
    attemptId: string,
    epoch: number,
    spentUsd: string,
  ): Promise<boolean>;
  /**
   * Whether a store's daily or monthly budget is spent (reserved spend
   * counts), so no ticket is issued (3).
   */
  budgetExhausted(owner: string, now: number, reserveUsd: string): Promise<boolean>;
  /** Count a handoff click (advisory, 3). */
  countClick(owner: string, address: string): Promise<void>;
  /**
   * Delete what has ended (5.8, K14): sessions past their end with their
   * history and ask records (resolving what their attempts still hold),
   * expired dedup ids and admin auth ids, and past days' session quotas.
   * Spend counters persist (usage, monthly budget).
   */
  sweep(now: number): Promise<void>;
}
