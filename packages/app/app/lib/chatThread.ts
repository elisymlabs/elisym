/**
 * Per-agent chat thread store on the IndexedDB kv store (stage 2 of
 * docs/plans/job-conversation-context-stage2-3.md).
 *
 * One key per agent (`chat-thread:<agentPubkey>`) holding the entry list,
 * ts-ascending. ALL mutations flow through this module: each one runs behind
 * an in-process per-key queue plus a `navigator.locks` mutex named after the
 * store key, and applies a single-IDB-transaction read-modify-write
 * (`cacheUpdate`) - separate get/set transactions would be a lost-update
 * hazard across tabs and within one tab.
 *
 * Outcome transitions (`completeEntry`, `failEntry`, the hydration merge's
 * completion arm) are STRICT update-if-present, never upsert: a transition
 * landing after its entry was purged or trimmed must not resurrect it.
 *
 * The store is subscribable (version counter + listeners, the readCursors
 * `useSyncExternalStore` pattern). The snapshot is per-tab: another tab's
 * writes surface through this tab's own hydration/reconcile cycles, not push.
 *
 * A thread-store lock and a chat-session lock are never held simultaneously
 * (cross-family ordering invariant): completion-driven `completedCount` bumps
 * fire only after the store mutation here has settled.
 */
import type { FileAttachment, PaymentAssetRef } from '@elisym/sdk';
import { cacheGet, cacheListKeys, cacheUpdate } from './localCache';
import { createKeyedQueue, webLocks, type LocksAdapter } from './locks';

export const CHAT_THREAD_KEY_PREFIX = 'chat-thread:';

/** Per-agent entry cap; oldest-by-`ts` trimmed on write, paid `pending` exempt. */
export const MAX_THREAD_ENTRIES = 500;

/** Outcome of an on-chain call a job produced. See `ChatThreadEntry.callStatus`. */
export type CallStatus = 'sent' | 'landed' | 'failed';

/**
 * What became of a claim write.
 *
 * `superseded` is the one that matters: a DIFFERENT blocking signature was
 * already recorded for this job, so this device lost a race - to another tab,
 * or to the hydration merge recovering a call another device landed. The caller
 * must abort rather than send, which a bare boolean could not tell it.
 */
export type ClaimOutcome = 'stored' | 'unstored' | 'superseded';

export interface ChatThreadEntry {
  jobEventId: string;
  /**
   * The Nostr identity that ran the job (send path) or the hydrating
   * identity. The thread renders only entries stamped with the current
   * identity; every entry is stamped by construction.
   */
  customerPubkey: string;
  /**
   * Context discriminator: a UUID = the send carried that session; `null` = a
   * deliberate stateless one-shot recorded by this device's send path; absent
   * = a hydrated entry whose wire payload carried no session.
   */
  sessionId?: string | null;
  capability: string;
  prompt: string;
  /** File-input descriptor (never the bytes) - same shape as today's `Artifact`. */
  promptAttachment?: FileAttachment;
  /** Raw amount in subunits of `asset` (lamports for SOL, 1e-6 for USDC). */
  priceLamports?: number;
  /** Payment asset descriptor. Undefined => native SOL (back-compat). */
  asset?: PaymentAssetRef;
  result?: string;
  /** File-output descriptors (never the bytes). */
  resultAttachments?: FileAttachment[];
  /** Absent = completed. */
  status?: 'pending' | 'failed';
  /**
   * Solana signature of the payment, when one was sent. A paid entry stays
   * `pending` indefinitely (never aged, never trimmed): money was sent, the
   * state must stay visible.
   */
  txHash?: string;
  /**
   * Solana signature of an on-chain CALL this entry produced and the customer
   * signed (`mode: onchain` capabilities). Distinct from `txHash`, which is the
   * payment for the job: this is the action the job's result asked for. Its
   * presence is also what stops the confirm sheet offering to sign the same
   * call a second time after a reload - a re-check would rebuild the call
   * against a fresh blockhash, so the second signature would genuinely land.
   */
  callSignature?: string;
  /**
   * What became of that call. `sent` means broadcast with no verdict yet -
   * honest, and still a reason not to sign again. `failed` means the chain
   * answered that it reverted: nothing moved, so the customer may legitimately
   * retry, and the confirm sheet must NOT treat it as already executed.
   */
  callStatus?: CallStatus;
  /**
   * Epoch MILLISECONDS. Hydration callers must convert Nostr `created_at`
   * seconds before writing - session liveness windows compare this against
   * `Date.now()`-based stamps.
   */
  ts: number;
}

/**
 * A relay-hydrated (always completed) entry: no local lifecycle fields, and
 * wire absence of a session is `sessionId` absent - never `null`.
 */
export type HydratedChatEntry = Omit<
  ChatThreadEntry,
  'status' | 'txHash' | 'callSignature' | 'callStatus' | 'sessionId'
> & {
  sessionId?: string;
  /**
   * Recovered from the CUSTOMER's own kind-7000 `call_tx` report, which is the
   * only record of a signed call that outlives this browser's storage. Without
   * it, a thread restored from relays comes back with no claim at all, and the
   * sheet offers an already-signed call as fresh - a second, real execution of
   * something the customer paid for once. Reachable by re-importing an
   * identity, opening the same nsec elsewhere, or clearing site data, and
   * bounded only by the envelope's 900s life.
   *
   * Recorded as `sent`, never `landed`, because the report does not say which.
   * This browser publishes one only after the chain confirms, but the MCP
   * client publishes for `assume-landed` too - a call it describes to its own
   * caller as "almost certainly landed. Verify it yourself" - and nothing in
   * the event distinguishes the two. `sent` blocks the sheet exactly as
   * `landed` would while telling the customer to check the signature, which is
   * the honest reading of a claim recovered from somewhere else.
   */
  callSignature?: string;
  callStatus?: 'sent';
};

export interface CompleteEntryFields {
  result?: string;
  resultAttachments?: FileAttachment[];
}

export interface MergeHydratedResult {
  /**
   * True only when this merge performed the `pending`/`failed` -> completed
   * transition. Callers key `completedCount` bumps off this - a settle
   * re-observing an already-completed entry bumps nothing.
   */
  completedTransitionFired: boolean;
  /** The merged entry's session UUID, when it has one (never the `null` marker). */
  sessionId?: string;
}

export interface ChatThreadStorageAdapter {
  get(key: string): Promise<ChatThreadEntry[] | undefined>;
  /**
   * Single-transaction read-modify-write; synchronous updater; undefined
   * deletes. Resolves `false` when the write did not durably commit.
   */
  update(
    key: string,
    updater: (current: ChatThreadEntry[] | undefined) => ChatThreadEntry[] | undefined,
  ): Promise<boolean>;
  listKeys(predicate: (key: string) => boolean): Promise<string[]>;
}

export interface ChatThreadStore {
  appendPendingEntry(agentPubkey: string, entry: Omit<ChatThreadEntry, 'status'>): Promise<void>;
  recordEntryTxHash(agentPubkey: string, jobEventId: string, txHash: string): Promise<boolean>;
  recordCallSignature(
    agentPubkey: string,
    jobEventId: string,
    callSignature: string,
    callStatus: CallStatus,
  ): Promise<ClaimOutcome>;
  completeEntry(
    agentPubkey: string,
    jobEventId: string,
    fields: CompleteEntryFields,
  ): Promise<boolean>;
  failEntry(agentPubkey: string, jobEventId: string): Promise<boolean>;
  mergeHydratedEntry(agentPubkey: string, entry: HydratedChatEntry): Promise<MergeHydratedResult>;
  readThread(agentPubkey: string): Promise<ChatThreadEntry[]>;
  agePendingEntries(
    agentPubkey: string,
    maxAgeMs: number,
    customerPubkey: string,
  ): Promise<ChatThreadEntry[]>;
  purgeIdentityThreadEntries(customerPubkey: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function chatThreadKey(agentPubkey: string): string {
  return `${CHAT_THREAD_KEY_PREFIX}${agentPubkey}`;
}

const idbThreadStorage: ChatThreadStorageAdapter = {
  get: (key) => cacheGet<ChatThreadEntry[]>(key),
  update: (key, updater) => cacheUpdate<ChatThreadEntry[]>(key, updater),
  listKeys: (predicate) => cacheListKeys(predicate),
};

function isPaidPending(entry: ChatThreadEntry): boolean {
  return entry.status === 'pending' && entry.txHash !== undefined;
}

function sessionUuidOf(entry: ChatThreadEntry): string | undefined {
  return typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
}

function sortByTs(entries: ChatThreadEntry[]): ChatThreadEntry[] {
  return [...entries].sort((left, right) => left.ts - right.ts);
}

/** Drop oldest-by-`ts` entries over the cap; paid `pending` entries are exempt. */
function trimToCap(entries: ChatThreadEntry[]): ChatThreadEntry[] {
  if (entries.length <= MAX_THREAD_ENTRIES) {
    return entries;
  }
  let excess = entries.length - MAX_THREAD_ENTRIES;
  const kept: ChatThreadEntry[] = [];
  for (const entry of entries) {
    if (excess > 0 && !isPaidPending(entry)) {
      excess -= 1;
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * Copy onto `stored` only the optional fields it LACKS. Never overwrites a
 * present field - in particular the `customerPubkey` stamp (required, always
 * present), `txHash` (hydrated entries carry none by type), and a present
 * `sessionId` including the deliberate `null` one-shot marker.
 */
function fillMissingFields(
  stored: ChatThreadEntry,
  hydrated: HydratedChatEntry,
): { merged: ChatThreadEntry; filled: boolean } {
  const merged: ChatThreadEntry = { ...stored };
  let filled = false;
  if (merged.sessionId === undefined && hydrated.sessionId !== undefined) {
    merged.sessionId = hydrated.sessionId;
    filled = true;
  }
  if (merged.promptAttachment === undefined && hydrated.promptAttachment !== undefined) {
    merged.promptAttachment = hydrated.promptAttachment;
    filled = true;
  }
  if (merged.priceLamports === undefined && hydrated.priceLamports !== undefined) {
    merged.priceLamports = hydrated.priceLamports;
    filled = true;
  }
  if (merged.asset === undefined && hydrated.asset !== undefined) {
    merged.asset = hydrated.asset;
    filled = true;
  }
  if (merged.result === undefined && hydrated.result !== undefined) {
    merged.result = hydrated.result;
    filled = true;
  }
  if (merged.resultAttachments === undefined && hydrated.resultAttachments !== undefined) {
    merged.resultAttachments = hydrated.resultAttachments;
    filled = true;
  }
  // A local claim that was SPENT outranks the report: `sent` means these bytes
  // went out and nobody has seen the verdict, so taking a report's word for
  // `landed` would claim a confirmation nobody observed.
  //
  // A local `failed` does NOT outrank it. It proves only that THIS device's
  // attempt never left - not that no call for this job landed. A report exists
  // only for a call its publisher watched land, so when the two disagree the
  // truthful reading is "another device already did this", and keeping the
  // local `failed` would leave the sheet offering a fresh signature for an
  // action the customer has already paid for and executed. Same signature is a
  // no-op, so a genuine retry is never refused by this.
  const localIsSpent = merged.callSignature !== undefined && merged.callStatus !== 'failed';
  if (
    !localIsSpent &&
    hydrated.callSignature !== undefined &&
    hydrated.callSignature !== merged.callSignature
  ) {
    merged.callSignature = hydrated.callSignature;
    merged.callStatus = hydrated.callStatus;
    filled = true;
  }
  return { merged, filled };
}

interface MutationOutcome<R> {
  entries: ChatThreadEntry[];
  changed: boolean;
  result: R;
}

export function createChatThreadStore(
  storage: ChatThreadStorageAdapter = idbThreadStorage,
  locks: LocksAdapter = webLocks,
): ChatThreadStore {
  const runQueued = createKeyedQueue();
  const listeners = new Set<() => void>();
  let storeVersion = 0;

  function notify(): void {
    storeVersion += 1;
    for (const listener of listeners) {
      listener();
    }
  }

  function mutateThread<R>(
    key: string,
    apply: (entries: ChatThreadEntry[]) => MutationOutcome<R>,
    fallback: R,
  ): Promise<R> {
    return runQueued(key, () =>
      locks.withLock(key, async () => {
        let outcome: MutationOutcome<R> | undefined;
        const committed = await storage.update(key, (current) => {
          const entries = Array.isArray(current) ? current : [];
          outcome = apply(entries);
          if (!outcome.changed) {
            // Unchanged: rewrite the current value (a no-op put; returning
            // undefined here would DELETE the key when it exists).
            return current;
          }
          return outcome.entries.length === 0 ? undefined : outcome.entries;
        });
        if (outcome === undefined || (!committed && outcome.changed)) {
          // Storage failure before the updater ran, or a transaction carrying a
          // real change that aborted after it - nothing durably changed;
          // best-effort degrade without claiming success or notifying.
          //
          // A verdict reached WITHOUT writing anything is kept, because the
          // commit it is waiting on is a no-op put. `superseded` is the case
          // that matters: it means another tab already claimed this job with a
          // different blocking signature, read inside this very transaction.
          // Degrading it to the `unstored` fallback tells the caller "the claim
          // did not store" - a warning, not a stop - and the caller then sends,
          // which is the paid action executed twice. The same applies to the
          // pre-send read, which would otherwise degrade to an empty thread and
          // hide the claim it exists to find.
          return fallback;
        }
        if (outcome.changed) {
          notify();
        }
        return outcome.result;
      }),
    );
  }

  async function appendPendingEntry(
    agentPubkey: string,
    entry: Omit<ChatThreadEntry, 'status'>,
  ): Promise<void> {
    await mutateThread(
      chatThreadKey(agentPubkey),
      (entries) => {
        // Bail when the id already exists: a hydration settle can complete the
        // job in the window between submit resolving and this append, and
        // re-inserting as `pending` would demote it (and double-bump the
        // session counter when hydration re-completes it).
        if (entries.some((existing) => existing.jobEventId === entry.jobEventId)) {
          return { entries, changed: false, result: undefined };
        }
        const pending: ChatThreadEntry = { ...entry, status: 'pending' };
        return {
          entries: trimToCap(sortByTs([...entries, pending])),
          changed: true,
          result: undefined,
        };
      },
      undefined,
    );
  }

  function recordEntryTxHash(
    agentPubkey: string,
    jobEventId: string,
    txHash: string,
  ): Promise<boolean> {
    return mutateThread(
      chatThreadKey(agentPubkey),
      (entries) => {
        const index = entries.findIndex((entry) => entry.jobEventId === jobEventId);
        const stored = index === -1 ? undefined : entries[index];
        if (stored === undefined) {
          // Strict update-if-present: never resurrect a purged/trimmed entry.
          return { entries, changed: false, result: false };
        }
        if (stored.txHash === txHash) {
          return { entries, changed: false, result: true };
        }
        const next = [...entries];
        next[index] = { ...stored, txHash };
        return { entries: next, changed: true, result: true };
      },
      false,
    );
  }

  /** Same strict update-if-present shape as `recordEntryTxHash`, for a signed call. */
  function recordCallSignature(
    agentPubkey: string,
    jobEventId: string,
    callSignature: string,
    callStatus: CallStatus,
  ): Promise<ClaimOutcome> {
    return mutateThread<ClaimOutcome>(
      chatThreadKey(agentPubkey),
      (entries) => {
        const index = entries.findIndex((entry) => entry.jobEventId === jobEventId);
        const stored = index === -1 ? undefined : entries[index];
        if (stored === undefined) {
          return { entries, changed: false, result: 'unstored' };
        }
        if (stored.callSignature === callSignature && stored.callStatus === callStatus) {
          return { entries, changed: false, result: 'stored' };
        }
        // COMPARE-AND-SET, inside the lock. A caller decides to claim from a
        // snapshot it read earlier, and between that read and this write the
        // hydration merge can commit a claim recovered from the customer's own
        // relay report - a call another device already landed. A blind write
        // would erase it and go on to send, which is the paid action executed
        // twice. Refusing here is what lets the caller abort instead.
        // Inlined rather than imported from `~/lib/onchainCall`, which imports
        // this module's types: a `failed` claim moved nothing and blocks
        // nothing, so writing over it is legitimate.
        const blocks = stored.callSignature !== undefined && stored.callStatus !== 'failed';
        if (blocks && stored.callSignature !== callSignature) {
          return { entries, changed: false, result: 'superseded' };
        }
        // A verdict never leaves `landed`. That is the chain's own answer, and
        // both ways out of it are wrong: rewriting it as `sent` puts "could not
        // confirm whether it landed" back in front of a customer whose call
        // demonstrably did, and rewriting it as `failed` turns the whole
        // double-execution guard OFF for a call that really happened, because
        // `blockingCallSignature` treats `failed` as nothing to block on.
        if (stored.callStatus === 'landed' && callStatus !== 'landed') {
          return { entries, changed: false, result: 'superseded' };
        }
        const next = [...entries];
        next[index] = { ...stored, callSignature, callStatus };
        return { entries: next, changed: true, result: 'stored' };
      },
      'unstored',
    );
  }

  function completeEntry(
    agentPubkey: string,
    jobEventId: string,
    fields: CompleteEntryFields,
  ): Promise<boolean> {
    return mutateThread(
      chatThreadKey(agentPubkey),
      (entries) => {
        const index = entries.findIndex((entry) => entry.jobEventId === jobEventId);
        const stored = index === -1 ? undefined : entries[index];
        if (stored === undefined || stored.status === undefined) {
          // Missing (never insert) or already completed (idempotent no-op).
          return { entries, changed: false, result: false };
        }
        const completed: ChatThreadEntry = { ...stored };
        delete completed.status;
        if (fields.result !== undefined) {
          completed.result = fields.result;
        }
        if (fields.resultAttachments !== undefined) {
          completed.resultAttachments = fields.resultAttachments;
        }
        const next = [...entries];
        next[index] = completed;
        return { entries: next, changed: true, result: true };
      },
      false,
    );
  }

  function failEntry(agentPubkey: string, jobEventId: string): Promise<boolean> {
    return mutateThread(
      chatThreadKey(agentPubkey),
      (entries) => {
        const index = entries.findIndex((entry) => entry.jobEventId === jobEventId);
        const stored = index === -1 ? undefined : entries[index];
        if (stored === undefined || stored.status !== 'pending') {
          // Missing, already failed, or completed - a completed entry must
          // never be demoted back to failed.
          return { entries, changed: false, result: false };
        }
        const next = [...entries];
        next[index] = { ...stored, status: 'failed' };
        return { entries: next, changed: true, result: true };
      },
      false,
    );
  }

  function mergeHydratedEntry(
    agentPubkey: string,
    hydrated: HydratedChatEntry,
  ): Promise<MergeHydratedResult> {
    return mutateThread<MergeHydratedResult>(
      chatThreadKey(agentPubkey),
      (entries) => {
        const index = entries.findIndex((entry) => entry.jobEventId === hydrated.jobEventId);
        const stored = index === -1 ? undefined : entries[index];
        if (stored === undefined) {
          // No stored entry: insert a completed, stamped entry.
          const inserted: ChatThreadEntry = { ...hydrated };
          return {
            entries: trimToCap(sortByTs([...entries, inserted])),
            changed: true,
            result: { completedTransitionFired: false, sessionId: sessionUuidOf(inserted) },
          };
        }
        const { merged, filled } = fillMissingFields(stored, hydrated);
        const hasHydratedResult =
          hydrated.result !== undefined || hydrated.resultAttachments !== undefined;
        let fired = false;
        if (stored.status !== undefined && hasHydratedResult) {
          // Stored pending/failed + hydrated result: complete atomically -
          // result fields written and status cleared in ONE update.
          if (hydrated.result !== undefined) {
            merged.result = hydrated.result;
          }
          if (hydrated.resultAttachments !== undefined) {
            merged.resultAttachments = hydrated.resultAttachments;
          }
          delete merged.status;
          fired = true;
        }
        const changed = fired || filled;
        if (!changed) {
          return {
            entries,
            changed: false,
            result: { completedTransitionFired: false, sessionId: sessionUuidOf(stored) },
          };
        }
        const next = [...entries];
        next[index] = merged;
        return {
          entries: next,
          changed: true,
          result: { completedTransitionFired: fired, sessionId: sessionUuidOf(merged) },
        };
      },
      { completedTransitionFired: false },
    );
  }

  async function readThread(agentPubkey: string): Promise<ChatThreadEntry[]> {
    const value = await storage.get(chatThreadKey(agentPubkey));
    return Array.isArray(value) ? value : [];
  }

  function agePendingEntries(
    agentPubkey: string,
    maxAgeMs: number,
    customerPubkey: string,
  ): Promise<ChatThreadEntry[]> {
    return mutateThread<ChatThreadEntry[]>(
      chatThreadKey(agentPubkey),
      (entries) => {
        const cutoff = Date.now() - maxAgeMs;
        const aged: ChatThreadEntry[] = [];
        const next = entries.map((entry) => {
          // Identity-scoped: the reconcile only queried results for ITS
          // identity's jobs - another identity's entries were never checked
          // and must not be aged on its behalf.
          const unpaidPending =
            entry.status === 'pending' &&
            entry.txHash === undefined &&
            entry.customerPubkey === customerPubkey;
          if (!unpaidPending || entry.ts >= cutoff) {
            return entry;
          }
          const failed: ChatThreadEntry = { ...entry, status: 'failed' };
          aged.push(failed);
          return failed;
        });
        return { entries: next, changed: aged.length > 0, result: aged };
      },
      [],
    );
  }

  async function purgeIdentityThreadEntries(customerPubkey: string): Promise<void> {
    const keys = await storage.listKeys((key) => key.startsWith(CHAT_THREAD_KEY_PREFIX));
    for (const key of keys) {
      await mutateThread(
        key,
        (entries) => {
          const next = entries.filter((entry) => entry.customerPubkey !== customerPubkey);
          return { entries: next, changed: next.length !== entries.length, result: undefined };
        },
        undefined,
      );
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function version(): number {
    return storeVersion;
  }

  return {
    appendPendingEntry,
    recordEntryTxHash,
    recordCallSignature,
    completeEntry,
    failEntry,
    mergeHydratedEntry,
    readThread,
    agePendingEntries,
    purgeIdentityThreadEntries,
    subscribe,
    version,
  };
}

const defaultStore = createChatThreadStore();

export const appendPendingEntry = defaultStore.appendPendingEntry;
export const recordEntryTxHash = defaultStore.recordEntryTxHash;
export const recordCallSignature = defaultStore.recordCallSignature;
export const completeEntry = defaultStore.completeEntry;
export const failEntry = defaultStore.failEntry;
export const mergeHydratedEntry = defaultStore.mergeHydratedEntry;
export const readThread = defaultStore.readThread;
export const agePendingEntries = defaultStore.agePendingEntries;
export const purgeIdentityThreadEntries = defaultStore.purgeIdentityThreadEntries;
/** Subscription surface for useSyncExternalStore (per-tab snapshot only). */
export const subscribeChatThread = defaultStore.subscribe;
export const chatThreadVersion = defaultStore.version;
