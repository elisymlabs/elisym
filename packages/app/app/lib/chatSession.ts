/**
 * Active chat session per (identityPubkey, agentPubkey) pair, in localStorage
 * (stage 2 of docs/plans/job-conversation-context-stage2-3.md).
 *
 * One localStorage key per pair (`elisym:chat-session:<identity>:<agent>`);
 * the lock name equals that key. Every mutation is a lock-held read-through
 * read-modify-write - the persisted value is re-read INSIDE the lock, never
 * RMW over a per-tab in-memory mirror. localStorage itself is synchronous,
 * but the lock serializes cross-tab check-then-act sequences (adopt, mint,
 * repair, the note's one-click switch).
 *
 * Rules pinned by the design:
 * - Adopt/mint resolution and the `inFlight` stamp are ONE lock-held mutation.
 * - `inFlight` is a token-keyed collection: append under lock, remove own
 *   token only, per-element 10-minute staleness, all lock-held.
 * - Adoption repair applies only to `origin: 'minted'` entries with
 *   `completedCount === 0`; it is DEFERRED (never consumed) while any fresh
 *   `inFlight` element or a pending thread entry under the current id exists.
 *   `'rotated'` entries are never upgraded; `'adopted'` never re-upgraded.
 * - `startedAt` per origin: mint/rotate stamp `now`; every adoption entry
 *   point (first-send adoption, repair, note switch) stamps the adopted
 *   candidate entry's `ts`.
 * - Mutations that find no entry (a token clear, a completion bump) never
 *   create one - a queued mutation racing the logout purge must not
 *   re-persist an entry for the logged-out identity.
 * - A chat-session lock and a thread-store lock are never held simultaneously
 *   (cross-family ordering invariant); candidate lists and pending flags are
 *   plain snapshot reads taken by the caller before entering the lock.
 */
import { createKeyedQueue, webLocks, type LocksAdapter } from './locks';

export const CHAT_SESSION_KEY_PREFIX = 'elisym:chat-session:';

/**
 * Adoption/divergence liveness window: the provider's session TTL is 30 days
 * (stage 1), so anything older than 25 days is treated as gone - offering a
 * session the provider already forgot would misattribute context.
 */
export const SESSION_LIVENESS_MS = 25 * 24 * 60 * 60 * 1000;

/**
 * Unpaid `pending` thread entries older than this age to `failed` on the
 * tab-open reconcile (the `PENDING_POLL_MAX_MS` precedent). Paid entries are
 * exempt - money was sent, the state must stay visible.
 */
export const UNPAID_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * An `inFlight` element older than this is stale (crashed tab or missed
 * clear) and is pruned - a stale element must not defer the repair forever.
 */
export const IN_FLIGHT_STALE_MS = 10 * 60 * 1000;

export type ChatSessionOrigin = 'adopted' | 'minted' | 'rotated';

export interface ChatSessionInFlight {
  /** Epoch milliseconds of the send's adopt/mint resolution. */
  since: number;
  /** Random token identifying the sending tab's in-flight send. */
  token: string;
}

export interface ChatSessionEntry {
  sessionId: string;
  /** Mint/rotate stamp `now`; adoption entry points stamp the candidate's `ts`. */
  startedAt: number;
  lastUsedAt: number;
  /** Completed exchanges under the CURRENT `sessionId` only. */
  completedCount: number;
  origin: ChatSessionOrigin;
  /** One element per concurrently-sending tab. */
  inFlight: ChatSessionInFlight[];
}

/**
 * An adoption/divergence candidate: an identity-scoped, UUID-carrying thread
 * entry. Scoping is the CALLER's job (the store is agent-keyed and retains
 * other identities' entries; adopting a foreign session id would target an
 * empty provider-side namespace).
 */
export interface SessionCandidate {
  sessionId: string;
  /** The thread entry's `ts`, epoch milliseconds. */
  ts: number;
}

export interface ResolvedSessionSend {
  sessionId: string;
  /** The `inFlight` token appended by this resolution; cleared via `clearInFlight`. */
  token: string;
}

export interface SessionStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  listKeys(): string[];
}

export interface ChatSessionStore {
  resolveSessionForSend(
    identityPubkey: string,
    agentPubkey: string,
    adoptionCandidates: SessionCandidate[],
  ): Promise<ResolvedSessionSend>;
  clearInFlight(identityPubkey: string, agentPubkey: string, token: string): Promise<void>;
  rotateSession(identityPubkey: string, agentPubkey: string): Promise<string>;
  repairMintedSession(
    identityPubkey: string,
    agentPubkey: string,
    candidates: SessionCandidate[],
    hasPendingUnderCurrentId: boolean,
  ): Promise<boolean>;
  recordCompletion(
    identityPubkey: string,
    agentPubkey: string,
    sessionId: string,
  ): Promise<boolean>;
  divergenceCandidate(
    identityPubkey: string,
    agentPubkey: string,
    candidates: SessionCandidate[],
  ): SessionCandidate | undefined;
  switchToSession(
    identityPubkey: string,
    agentPubkey: string,
    candidate: SessionCandidate,
    hasPendingOrInFlight: boolean,
  ): Promise<boolean>;
  selectSession(
    identityPubkey: string,
    agentPubkey: string,
    candidate: SessionCandidate,
  ): Promise<boolean>;
  purgeChatSessions(identityPubkey: string): Promise<void>;
  readChatSession(identityPubkey: string, agentPubkey: string): ChatSessionEntry | undefined;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export function chatSessionKey(identityPubkey: string, agentPubkey: string): string {
  return `${CHAT_SESSION_KEY_PREFIX}${identityPubkey}:${agentPubkey}`;
}

const browserSessionStorage: SessionStorageAdapter = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Quota/private-mode failures degrade to per-tab state - harmless.
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // best-effort
    }
  },
  listKeys: () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) {
          keys.push(key);
        }
      }
      return keys;
    } catch {
      return [];
    }
  },
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOrigin(value: unknown): value is ChatSessionOrigin {
  return value === 'adopted' || value === 'minted' || value === 'rotated';
}

function parseInFlight(value: unknown): ChatSessionInFlight[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const elements: ChatSessionInFlight[] = [];
  for (const element of value) {
    if (typeof element !== 'object' || element === null) {
      continue;
    }
    if (!('since' in element) || !('token' in element)) {
      continue;
    }
    const { since, token } = element;
    if (isFiniteNumber(since) && typeof token === 'string') {
      elements.push({ since, token });
    }
  }
  return elements;
}

/** Tolerant parse (the readCursors idiom): a corrupt value reads as absent. */
function parseEntry(raw: string | null): ChatSessionEntry | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  if (
    !('sessionId' in parsed) ||
    !('startedAt' in parsed) ||
    !('lastUsedAt' in parsed) ||
    !('completedCount' in parsed) ||
    !('origin' in parsed)
  ) {
    return undefined;
  }
  const { sessionId, startedAt, lastUsedAt, completedCount, origin } = parsed;
  if (
    typeof sessionId !== 'string' ||
    !isFiniteNumber(startedAt) ||
    !isFiniteNumber(lastUsedAt) ||
    !isFiniteNumber(completedCount) ||
    !isOrigin(origin)
  ) {
    return undefined;
  }
  const inFlight = 'inFlight' in parsed ? parseInFlight(parsed.inFlight) : [];
  return { sessionId, startedAt, lastUsedAt, completedCount, origin, inFlight };
}

/** Newest candidate within the liveness window, optionally excluding a session id. */
function newestLiveCandidate(
  candidates: SessionCandidate[],
  now: number,
  excludeSessionId?: string,
): SessionCandidate | undefined {
  let newest: SessionCandidate | undefined;
  for (const candidate of candidates) {
    if (now - candidate.ts > SESSION_LIVENESS_MS) {
      continue;
    }
    if (excludeSessionId !== undefined && candidate.sessionId === excludeSessionId) {
      continue;
    }
    if (newest === undefined || candidate.ts > newest.ts) {
      newest = candidate;
    }
  }
  return newest;
}

function newestCandidate(candidates: SessionCandidate[]): SessionCandidate | undefined {
  let newest: SessionCandidate | undefined;
  for (const candidate of candidates) {
    if (newest === undefined || candidate.ts > newest.ts) {
      newest = candidate;
    }
  }
  return newest;
}

interface SessionMutationOutcome<R> {
  entry: ChatSessionEntry | undefined;
  changed: boolean;
  result: R;
}

export function createChatSessionStore(
  storage: SessionStorageAdapter = browserSessionStorage,
  locks: LocksAdapter = webLocks,
): ChatSessionStore {
  const runQueued = createKeyedQueue();
  const listeners = new Set<() => void>();
  let storeVersion = 0;

  function notify(): void {
    storeVersion += 1;
    for (const listener of listeners) {
      listener();
    }
  }

  function mutateSession<R>(
    key: string,
    apply: (current: ChatSessionEntry | undefined) => SessionMutationOutcome<R>,
  ): Promise<R> {
    return runQueued(key, () =>
      locks.withLock(key, async () => {
        const current = parseEntry(storage.getItem(key));
        const outcome = apply(current);
        if (outcome.changed) {
          if (outcome.entry === undefined) {
            storage.removeItem(key);
          } else {
            storage.setItem(key, JSON.stringify(outcome.entry));
          }
          notify();
        }
        return outcome.result;
      }),
    );
  }

  function resolveSessionForSend(
    identityPubkey: string,
    agentPubkey: string,
    adoptionCandidates: SessionCandidate[],
  ): Promise<ResolvedSessionSend> {
    return mutateSession<ResolvedSessionSend>(
      chatSessionKey(identityPubkey, agentPubkey),
      (current) => {
        const now = Date.now();
        const token = crypto.randomUUID();
        let entry: ChatSessionEntry;
        if (current !== undefined) {
          entry = {
            ...current,
            lastUsedAt: now,
            inFlight: [...current.inFlight, { since: now, token }],
          };
        } else {
          const candidate = newestLiveCandidate(adoptionCandidates, now);
          entry =
            candidate !== undefined
              ? {
                  sessionId: candidate.sessionId,
                  startedAt: candidate.ts,
                  lastUsedAt: now,
                  completedCount: 0,
                  origin: 'adopted',
                  inFlight: [{ since: now, token }],
                }
              : {
                  sessionId: crypto.randomUUID(),
                  startedAt: now,
                  lastUsedAt: now,
                  completedCount: 0,
                  origin: 'minted',
                  inFlight: [{ since: now, token }],
                };
        }
        return { entry, changed: true, result: { sessionId: entry.sessionId, token } };
      },
    );
  }

  function clearInFlight(
    identityPubkey: string,
    agentPubkey: string,
    token: string,
  ): Promise<void> {
    return mutateSession(chatSessionKey(identityPubkey, agentPubkey), (current) => {
      if (current === undefined) {
        // Never create an absent entry.
        return { entry: undefined, changed: false, result: undefined };
      }
      const remaining = current.inFlight.filter((element) => element.token !== token);
      if (remaining.length === current.inFlight.length) {
        return { entry: current, changed: false, result: undefined };
      }
      return { entry: { ...current, inFlight: remaining }, changed: true, result: undefined };
    });
  }

  function rotateSession(identityPubkey: string, agentPubkey: string): Promise<string> {
    return mutateSession<string>(chatSessionKey(identityPubkey, agentPubkey), () => {
      const now = Date.now();
      const entry: ChatSessionEntry = {
        sessionId: crypto.randomUUID(),
        startedAt: now,
        lastUsedAt: now,
        completedCount: 0,
        origin: 'rotated',
        inFlight: [],
      };
      return { entry, changed: true, result: entry.sessionId };
    });
  }

  function repairMintedSession(
    identityPubkey: string,
    agentPubkey: string,
    candidates: SessionCandidate[],
    hasPendingUnderCurrentId: boolean,
  ): Promise<boolean> {
    return mutateSession<boolean>(chatSessionKey(identityPubkey, agentPubkey), (current) => {
      if (current === undefined) {
        return { entry: undefined, changed: false, result: false };
      }
      const now = Date.now();
      const freshInFlight = current.inFlight.filter(
        (element) => now - element.since < IN_FLIGHT_STALE_MS,
      );
      const pruned = freshInFlight.length !== current.inFlight.length;
      const base: ChatSessionEntry = pruned ? { ...current, inFlight: freshInFlight } : current;
      if (current.origin !== 'minted' || current.completedCount !== 0) {
        // Disarmed by content or rotation: 'rotated' is never upgraded,
        // 'adopted' never re-upgraded, a real exchange keeps its session.
        return { entry: base, changed: pruned, result: false };
      }
      if (freshInFlight.length > 0 || hasPendingUnderCurrentId) {
        // Deferred, NOT consumed - re-evaluated at the next hydration settle.
        return { entry: base, changed: pruned, result: false };
      }
      const candidate = newestLiveCandidate(candidates, now, current.sessionId);
      if (candidate === undefined) {
        return { entry: base, changed: pruned, result: false };
      }
      const entry: ChatSessionEntry = {
        sessionId: candidate.sessionId,
        startedAt: candidate.ts,
        lastUsedAt: now,
        completedCount: 0,
        origin: 'adopted',
        inFlight: freshInFlight,
      };
      return { entry, changed: true, result: true };
    });
  }

  function recordCompletion(
    identityPubkey: string,
    agentPubkey: string,
    sessionId: string,
  ): Promise<boolean> {
    return mutateSession<boolean>(chatSessionKey(identityPubkey, agentPubkey), (current) => {
      if (current === undefined) {
        // Never create an absent entry.
        return { entry: undefined, changed: false, result: false };
      }
      if (current.sessionId !== sessionId) {
        // A completion for a rotated-away or upgraded-away id never bumps.
        return { entry: current, changed: false, result: false };
      }
      return {
        entry: { ...current, completedCount: current.completedCount + 1 },
        changed: true,
        result: true,
      };
    });
  }

  function readChatSession(
    identityPubkey: string,
    agentPubkey: string,
  ): ChatSessionEntry | undefined {
    return parseEntry(storage.getItem(chatSessionKey(identityPubkey, agentPubkey)));
  }

  function divergenceCandidate(
    identityPubkey: string,
    agentPubkey: string,
    candidates: SessionCandidate[],
  ): SessionCandidate | undefined {
    const current = readChatSession(identityPubkey, agentPubkey);
    if (current === undefined) {
      return undefined;
    }
    // The trigger is THE newest UUID-carrying entry (not the newest foreign
    // one): if the thread visibly ends with the current conversation there is
    // nothing newer to join.
    const newest = newestCandidate(candidates);
    if (newest === undefined || newest.sessionId === current.sessionId) {
      return undefined;
    }
    const now = Date.now();
    if (newest.ts <= current.startedAt) {
      // Post-rotation suppression: rotation stamps startedAt = now, so the
      // just-left conversation is never offered back.
      return undefined;
    }
    if (now - newest.ts > SESSION_LIVENESS_MS) {
      return undefined;
    }
    return newest;
  }

  function switchToSession(
    identityPubkey: string,
    agentPubkey: string,
    candidate: SessionCandidate,
    hasPendingOrInFlight: boolean,
  ): Promise<boolean> {
    return mutateSession<boolean>(chatSessionKey(identityPubkey, agentPubkey), (current) => {
      if (current === undefined) {
        return { entry: undefined, changed: false, result: false };
      }
      const now = Date.now();
      const freshInFlight = current.inFlight.filter(
        (element) => now - element.since < IN_FLIGHT_STALE_MS,
      );
      const pruned = freshInFlight.length !== current.inFlight.length;
      const base: ChatSessionEntry = pruned ? { ...current, inFlight: freshInFlight } : current;
      // FULL re-validation under the lock: a note rendered in one tab stays on
      // screen indefinitely; a sibling tab may have sent, rotated, or adopted
      // since. A stale note must never revert an explicit "New conversation".
      const valid =
        !hasPendingOrInFlight &&
        freshInFlight.length === 0 &&
        candidate.sessionId !== current.sessionId &&
        candidate.ts > current.startedAt &&
        now - candidate.ts <= SESSION_LIVENESS_MS;
      if (!valid) {
        return { entry: base, changed: pruned, result: false };
      }
      const entry: ChatSessionEntry = {
        sessionId: candidate.sessionId,
        startedAt: candidate.ts,
        lastUsedAt: now,
        completedCount: 0,
        origin: 'adopted',
        inFlight: freshInFlight,
      };
      return { entry, changed: true, result: true };
    });
  }

  function selectSession(
    identityPubkey: string,
    agentPubkey: string,
    candidate: SessionCandidate,
  ): Promise<boolean> {
    return mutateSession<boolean>(chatSessionKey(identityPubkey, agentPubkey), (current) => {
      const now = Date.now();
      const freshInFlight = (current?.inFlight ?? []).filter(
        (element) => now - element.since < IN_FLIGHT_STALE_MS,
      );
      const pruned = current !== undefined && freshInFlight.length !== current.inFlight.length;
      const base: ChatSessionEntry | undefined =
        current !== undefined && pruned ? { ...current, inFlight: freshInFlight } : current;
      if (freshInFlight.length > 0) {
        // A send is resolving against the current id - switching now would
        // strand that send's entry under an unselected conversation.
        return { entry: base, changed: pruned, result: false };
      }
      if (current !== undefined && current.sessionId === candidate.sessionId) {
        return { entry: base, changed: pruned, result: true };
      }
      // Explicit user selection from the chat list: unlike `switchToSession`
      // (a passive cross-device note), it applies regardless of age or
      // newer-than ordering, and may create an absent entry - the click IS
      // the adoption entry point. `lastUsedAt` takes the conversation's last
      // known activity so the stale hint stays truthful for an old chat.
      const entry: ChatSessionEntry = {
        sessionId: candidate.sessionId,
        startedAt: candidate.ts,
        lastUsedAt: candidate.ts,
        completedCount: 0,
        origin: 'adopted',
        inFlight: [],
      };
      return { entry, changed: true, result: true };
    });
  }

  async function purgeChatSessions(identityPubkey: string): Promise<void> {
    const prefix = `${CHAT_SESSION_KEY_PREFIX}${identityPubkey}:`;
    const keys = storage.listKeys().filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      await mutateSession(key, (current) => ({
        entry: undefined,
        changed: current !== undefined,
        result: undefined,
      }));
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
    resolveSessionForSend,
    clearInFlight,
    rotateSession,
    repairMintedSession,
    recordCompletion,
    divergenceCandidate,
    switchToSession,
    selectSession,
    purgeChatSessions,
    readChatSession,
    subscribe,
    version,
  };
}

const defaultStore = createChatSessionStore();

export const resolveSessionForSend = defaultStore.resolveSessionForSend;
export const clearInFlight = defaultStore.clearInFlight;
export const rotateSession = defaultStore.rotateSession;
export const repairMintedSession = defaultStore.repairMintedSession;
export const recordCompletion = defaultStore.recordCompletion;
export const divergenceCandidate = defaultStore.divergenceCandidate;
export const switchToSession = defaultStore.switchToSession;
export const selectSession = defaultStore.selectSession;
export const purgeChatSessions = defaultStore.purgeChatSessions;
export const readChatSession = defaultStore.readChatSession;
/** Subscription surface for useSyncExternalStore (per-tab snapshot only). */
export const subscribeChatSessions = defaultStore.subscribe;
export const chatSessionsVersion = defaultStore.version;
