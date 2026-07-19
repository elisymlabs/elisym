/**
 * Active-session store tests (stage 2 design, `chatSession.ts`): adoption
 * window/ordering, mint fallback, one-lock-held resolve+stamp, inFlight token
 * isolation, repair guards (origin/content disarm, deferred-not-consumed,
 * stale-element prune), current-id-keyed completion bumps, divergence-note
 * trigger, switchToSession full re-validation, rotation semantics, purge, and
 * the no-create-on-absent rule.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_SESSION_KEY_PREFIX,
  chatSessionKey,
  createChatSessionStore,
  IN_FLIGHT_STALE_MS,
  SESSION_LIVENESS_MS,
  UNPAID_PENDING_MAX_AGE_MS,
  type ChatSessionEntry,
  type SessionCandidate,
  type SessionStorageAdapter,
} from '../app/lib/chatSession';
import type { LocksAdapter } from '../app/lib/locks';

const IDENTITY = 'identity-a';
const OTHER_IDENTITY = 'identity-b';
const AGENT = 'agent-pubkey-1';
const OTHER_AGENT = 'agent-pubkey-2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

interface MemorySessionStorage extends SessionStorageAdapter {
  map: Map<string, string>;
}

function createMemoryStorage(): MemorySessionStorage {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    listKeys: () => [...map.keys()],
  };
}

interface RecordingLocks extends LocksAdapter {
  names: string[];
}

function createRecordingLocks(): RecordingLocks {
  const names: string[] = [];
  return {
    names,
    withLock(name, task) {
      names.push(name);
      return task();
    },
  };
}

function createStore() {
  const storage = createMemoryStorage();
  const locks = createRecordingLocks();
  const store = createChatSessionStore(storage, locks);
  return { storage, locks, store };
}

function seedEntry(
  storage: MemorySessionStorage,
  identityPubkey: string,
  agentPubkey: string,
  entry: ChatSessionEntry,
): void {
  storage.map.set(chatSessionKey(identityPubkey, agentPubkey), JSON.stringify(entry));
}

function sessionEntry(overrides: Partial<ChatSessionEntry> = {}): ChatSessionEntry {
  return {
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    startedAt: Date.now() - 1000,
    lastUsedAt: Date.now() - 1000,
    completedCount: 0,
    origin: 'minted',
    inFlight: [],
    ...overrides,
  };
}

function candidate(sessionId: string, ts: number): SessionCandidate {
  return { sessionId, ts };
}

describe('constants', () => {
  it('exports the design-pinned windows', () => {
    expect(SESSION_LIVENESS_MS).toBe(25 * DAY_MS);
    expect(UNPAID_PENDING_MAX_AGE_MS).toBe(DAY_MS);
    expect(IN_FLIGHT_STALE_MS).toBe(10 * 60 * 1000);
  });
});

describe('resolveSessionForSend', () => {
  it('mints a fresh UUID session when nothing exists and nothing is adoptable', async () => {
    const { store } = createStore();
    const before = Date.now();
    const resolved = await store.resolveSessionForSend(IDENTITY, AGENT, []);
    const after = Date.now();
    expect(resolved.sessionId).toMatch(UUID_RE);
    expect(resolved.token).toMatch(UUID_RE);
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.origin).toBe('minted');
    expect(entry?.completedCount).toBe(0);
    expect(entry?.startedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.startedAt).toBeLessThanOrEqual(after);
    // The mint and the inFlight stamp are ONE lock-held mutation.
    expect(entry?.inFlight).toEqual([{ since: entry?.startedAt, token: resolved.token }]);
  });

  it('holds the lock named after the localStorage key', async () => {
    const { store, locks } = createStore();
    await store.resolveSessionForSend(IDENTITY, AGENT, []);
    expect(locks.names).toEqual([chatSessionKey(IDENTITY, AGENT)]);
    expect(chatSessionKey(IDENTITY, AGENT)).toBe(`${CHAT_SESSION_KEY_PREFIX}${IDENTITY}:${AGENT}`);
  });

  it('adopts the newest live candidate and stamps startedAt with the candidate ts', async () => {
    const { store } = createStore();
    const now = Date.now();
    const older = candidate('aaaaaaaa-0000-4000-8000-00000000000a', now - 3 * DAY_MS);
    const newest = candidate('bbbbbbbb-0000-4000-8000-00000000000b', now - DAY_MS);
    const resolved = await store.resolveSessionForSend(IDENTITY, AGENT, [older, newest]);
    expect(resolved.sessionId).toBe(newest.sessionId);
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.origin).toBe('adopted');
    // Adoption stamps the candidate entry's ts, NOT the adoption instant.
    expect(entry?.startedAt).toBe(newest.ts);
  });

  it('ignores candidates outside the 25-day liveness window and mints instead', async () => {
    const { store } = createStore();
    const stale = candidate('aaaaaaaa-0000-4000-8000-00000000000a', Date.now() - 26 * DAY_MS);
    const resolved = await store.resolveSessionForSend(IDENTITY, AGENT, [stale]);
    expect(resolved.sessionId).not.toBe(stale.sessionId);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('minted');
  });

  it('returns the existing entry sessionId without re-adopting', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ origin: 'adopted' }));
    const newer = candidate('bbbbbbbb-0000-4000-8000-00000000000b', Date.now());
    const resolved = await store.resolveSessionForSend(IDENTITY, AGENT, [newer]);
    expect(resolved.sessionId).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.origin).toBe('adopted');
    expect(entry?.inFlight).toHaveLength(1);
  });

  it('bumps lastUsedAt on every send resolution', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ lastUsedAt: Date.now() - DAY_MS }));
    const before = Date.now();
    await store.resolveSessionForSend(IDENTITY, AGENT, []);
    expect(store.readChatSession(IDENTITY, AGENT)?.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it('keeps two concurrent sends isolated: both tokens appended, own-token clear only', async () => {
    const { store } = createStore();
    const [first, second] = await Promise.all([
      store.resolveSessionForSend(IDENTITY, AGENT, []),
      store.resolveSessionForSend(IDENTITY, AGENT, []),
    ]);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.token).not.toBe(second.token);
    let entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.inFlight.map((element) => element.token).sort()).toEqual(
      [first.token, second.token].sort(),
    );
    // Tab A clears its own token; tab B's fresh element survives.
    await store.clearInFlight(IDENTITY, AGENT, first.token);
    entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.inFlight.map((element) => element.token)).toEqual([second.token]);
  });
});

describe('clearInFlight', () => {
  it('never creates an absent entry', async () => {
    const { store, storage } = createStore();
    await store.clearInFlight(IDENTITY, AGENT, 'no-such-token');
    expect(storage.map.size).toBe(0);
  });

  it('is a no-op for an unknown token', async () => {
    const { store, storage } = createStore();
    const stamped = { since: Date.now(), token: 'known-token' };
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ inFlight: [stamped] }));
    await store.clearInFlight(IDENTITY, AGENT, 'other-token');
    expect(store.readChatSession(IDENTITY, AGENT)?.inFlight).toEqual([stamped]);
  });
});

describe('rotateSession', () => {
  it('mints a new id with origin rotated, startedAt = now, count reset, inFlight cleared', async () => {
    const { store, storage } = createStore();
    seedEntry(
      storage,
      IDENTITY,
      AGENT,
      sessionEntry({
        origin: 'adopted',
        completedCount: 4,
        startedAt: Date.now() - 5 * DAY_MS,
        inFlight: [{ since: Date.now(), token: 'live-token' }],
      }),
    );
    const before = Date.now();
    const rotatedId = await store.rotateSession(IDENTITY, AGENT);
    expect(rotatedId).toMatch(UUID_RE);
    expect(rotatedId).not.toBe('aaaaaaaa-0000-4000-8000-000000000001');
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.origin).toBe('rotated');
    expect(entry?.startedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.completedCount).toBe(0);
    expect(entry?.inFlight).toEqual([]);
  });
});

describe('repairMintedSession', () => {
  const liveCandidate = () =>
    candidate('cccccccc-0000-4000-8000-00000000000c', Date.now() - DAY_MS);

  it('replaces a minted zero-completed entry with the newest live candidate', async () => {
    const { store } = createStore();
    await store.resolveSessionForSend(IDENTITY, AGENT, []);
    const minted = store.readChatSession(IDENTITY, AGENT);
    await store.clearInFlight(IDENTITY, AGENT, minted?.inFlight[0]?.token ?? '');
    const target = liveCandidate();
    const repaired = await store.repairMintedSession(IDENTITY, AGENT, [target], false);
    expect(repaired).toBe(true);
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.sessionId).toBe(target.sessionId);
    expect(entry?.origin).toBe('adopted');
    expect(entry?.startedAt).toBe(target.ts);
  });

  it('never upgrades a rotated entry (explicit "New conversation" wins)', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ origin: 'rotated' }));
    expect(await store.repairMintedSession(IDENTITY, AGENT, [liveCandidate()], false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.sessionId).toBe(
      'aaaaaaaa-0000-4000-8000-000000000001',
    );
  });

  it('never re-upgrades an adopted entry', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ origin: 'adopted' }));
    expect(await store.repairMintedSession(IDENTITY, AGENT, [liveCandidate()], false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('adopted');
  });

  it('is disarmed by content: a completed exchange keeps the minted session', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ origin: 'minted', completedCount: 1 }));
    expect(await store.repairMintedSession(IDENTITY, AGENT, [liveCandidate()], false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('minted');
  });

  it('defers (not consumes) while a fresh inFlight element exists', async () => {
    const { store } = createStore();
    const resolved = await store.resolveSessionForSend(IDENTITY, AGENT, []);
    const target = liveCandidate();
    // Send in flight: deferred.
    expect(await store.repairMintedSession(IDENTITY, AGENT, [target], false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('minted');
    // The deferral did NOT consume the repair: after the send exits entry-less,
    // the next settle repairs.
    await store.clearInFlight(IDENTITY, AGENT, resolved.token);
    expect(await store.repairMintedSession(IDENTITY, AGENT, [target], false)).toBe(true);
    expect(store.readChatSession(IDENTITY, AGENT)?.sessionId).toBe(target.sessionId);
  });

  it('defers (not consumes) while a pending thread entry exists under the current id', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ origin: 'minted' }));
    const target = liveCandidate();
    expect(await store.repairMintedSession(IDENTITY, AGENT, [target], true)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('minted');
    expect(await store.repairMintedSession(IDENTITY, AGENT, [target], false)).toBe(true);
  });

  it('prunes stale inFlight elements and proceeds', async () => {
    const { store, storage } = createStore();
    seedEntry(
      storage,
      IDENTITY,
      AGENT,
      sessionEntry({
        origin: 'minted',
        inFlight: [{ since: Date.now() - IN_FLIGHT_STALE_MS - 1000, token: 'crashed-tab' }],
      }),
    );
    const target = liveCandidate();
    expect(await store.repairMintedSession(IDENTITY, AGENT, [target], false)).toBe(true);
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.sessionId).toBe(target.sessionId);
    expect(entry?.inFlight).toEqual([]);
  });

  it('persists the stale-element prune even when the repair does not fire', async () => {
    const { store, storage } = createStore();
    seedEntry(
      storage,
      IDENTITY,
      AGENT,
      sessionEntry({
        origin: 'rotated',
        inFlight: [{ since: Date.now() - IN_FLIGHT_STALE_MS - 1000, token: 'crashed-tab' }],
      }),
    );
    expect(await store.repairMintedSession(IDENTITY, AGENT, [], false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.inFlight).toEqual([]);
  });

  it('does not repair from stale candidates or when none exist', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ origin: 'minted' }));
    const stale = candidate('cccccccc-0000-4000-8000-00000000000c', Date.now() - 26 * DAY_MS);
    expect(await store.repairMintedSession(IDENTITY, AGENT, [stale], false)).toBe(false);
    expect(await store.repairMintedSession(IDENTITY, AGENT, [], false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('minted');
  });

  it('is a no-op on an absent entry (never creates one)', async () => {
    const { store, storage } = createStore();
    expect(await store.repairMintedSession(IDENTITY, AGENT, [liveCandidate()], false)).toBe(false);
    expect(storage.map.size).toBe(0);
  });
});

describe('recordCompletion', () => {
  it('bumps completedCount only when the sessionId matches the CURRENT one', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry());
    expect(
      await store.recordCompletion(IDENTITY, AGENT, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toBe(true);
    expect(store.readChatSession(IDENTITY, AGENT)?.completedCount).toBe(1);
    // A completion for a rotated-away id never bumps the current entry.
    await store.rotateSession(IDENTITY, AGENT);
    expect(
      await store.recordCompletion(IDENTITY, AGENT, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.completedCount).toBe(0);
  });

  it('never creates an absent entry', async () => {
    const { store, storage } = createStore();
    expect(
      await store.recordCompletion(IDENTITY, AGENT, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toBe(false);
    expect(storage.map.size).toBe(0);
  });
});

describe('divergenceCandidate', () => {
  const CURRENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const FOREIGN_ID = 'dddddddd-0000-4000-8000-00000000000d';

  it('fires for a legit newer foreign session', () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    const newer = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    const own = candidate(CURRENT_ID, Date.now() - 4 * DAY_MS);
    expect(store.divergenceCandidate(IDENTITY, AGENT, [own, newer])).toEqual(newer);
  });

  it('is suppressed right after a rotation (startedAt recency)', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    await store.rotateSession(IDENTITY, AGENT);
    // The just-left conversation's entries are all older than the rotation.
    const justLeft = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    expect(store.divergenceCandidate(IDENTITY, AGENT, [justLeft])).toBeUndefined();
  });

  it('is suppressed when the newest entry belongs to the current session', () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    const olderForeign = candidate(FOREIGN_ID, Date.now() - 2 * DAY_MS);
    const newestOwn = candidate(CURRENT_ID, Date.now() - DAY_MS);
    expect(store.divergenceCandidate(IDENTITY, AGENT, [olderForeign, newestOwn])).toBeUndefined();
  });

  it('is suppressed for candidates outside the 25-day liveness window', () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 30 * DAY_MS }));
    const stale = candidate(FOREIGN_ID, Date.now() - 26 * DAY_MS);
    expect(store.divergenceCandidate(IDENTITY, AGENT, [stale])).toBeUndefined();
  });

  it('returns undefined with no map entry or no candidates', () => {
    const { store, storage } = createStore();
    expect(
      store.divergenceCandidate(IDENTITY, AGENT, [candidate(FOREIGN_ID, Date.now())]),
    ).toBeUndefined();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry());
    expect(store.divergenceCandidate(IDENTITY, AGENT, [])).toBeUndefined();
  });
});

describe('switchToSession', () => {
  const FOREIGN_ID = 'dddddddd-0000-4000-8000-00000000000d';

  it('switches when the full precondition set re-validates under the lock', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    const target = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, target, false)).toBe(true);
    const entry = store.readChatSession(IDENTITY, AGENT);
    expect(entry?.sessionId).toBe(FOREIGN_ID);
    expect(entry?.origin).toBe('adopted');
    expect(entry?.startedAt).toBe(target.ts);
    expect(entry?.completedCount).toBe(0);
  });

  it('aborts when the candidate equals the current session', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    const same = candidate('aaaaaaaa-0000-4000-8000-000000000001', Date.now() - DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, same, false)).toBe(false);
  });

  it('aborts after a sibling rotation (candidate ts not newer than startedAt)', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    const target = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    // A sibling tab rotates between note render and click: startedAt = now.
    await store.rotateSession(IDENTITY, AGENT);
    expect(await store.switchToSession(IDENTITY, AGENT, target, false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.origin).toBe('rotated');
  });

  it('aborts for a candidate outside the liveness window', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 30 * DAY_MS }));
    const stale = candidate(FOREIGN_ID, Date.now() - 26 * DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, stale, false)).toBe(false);
  });

  it('aborts while the caller reports pending/in-flight activity', async () => {
    const { store, storage } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry({ startedAt: Date.now() - 5 * DAY_MS }));
    const target = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, target, true)).toBe(false);
  });

  it('aborts while a fresh inFlight element exists (re-read under the lock)', async () => {
    const { store, storage } = createStore();
    seedEntry(
      storage,
      IDENTITY,
      AGENT,
      sessionEntry({
        startedAt: Date.now() - 5 * DAY_MS,
        inFlight: [{ since: Date.now(), token: 'sibling-send' }],
      }),
    );
    const target = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, target, false)).toBe(false);
    expect(store.readChatSession(IDENTITY, AGENT)?.sessionId).toBe(
      'aaaaaaaa-0000-4000-8000-000000000001',
    );
  });

  it('prunes a stale inFlight element instead of letting it block forever', async () => {
    const { store, storage } = createStore();
    seedEntry(
      storage,
      IDENTITY,
      AGENT,
      sessionEntry({
        startedAt: Date.now() - 5 * DAY_MS,
        inFlight: [{ since: Date.now() - IN_FLIGHT_STALE_MS - 1000, token: 'crashed-tab' }],
      }),
    );
    const target = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, target, false)).toBe(true);
    expect(store.readChatSession(IDENTITY, AGENT)?.inFlight).toEqual([]);
  });

  it('aborts on an absent entry (never creates one)', async () => {
    const { store, storage } = createStore();
    const target = candidate(FOREIGN_ID, Date.now() - DAY_MS);
    expect(await store.switchToSession(IDENTITY, AGENT, target, false)).toBe(false);
    expect(storage.map.size).toBe(0);
  });
});

describe('purgeChatSessions', () => {
  it('deletes only the purged identity keys, lock-held', async () => {
    const { store, storage, locks } = createStore();
    seedEntry(storage, IDENTITY, AGENT, sessionEntry());
    seedEntry(storage, IDENTITY, OTHER_AGENT, sessionEntry());
    seedEntry(storage, OTHER_IDENTITY, AGENT, sessionEntry());
    await store.purgeChatSessions(IDENTITY);
    expect(storage.map.has(chatSessionKey(IDENTITY, AGENT))).toBe(false);
    expect(storage.map.has(chatSessionKey(IDENTITY, OTHER_AGENT))).toBe(false);
    expect(storage.map.has(chatSessionKey(OTHER_IDENTITY, AGENT))).toBe(true);
    expect(locks.names).toContain(chatSessionKey(IDENTITY, AGENT));
    expect(locks.names).toContain(chatSessionKey(IDENTITY, OTHER_AGENT));
  });

  it('post-purge mutations that find no entry do not re-create it', async () => {
    const { store, storage } = createStore();
    seedEntry(
      storage,
      IDENTITY,
      AGENT,
      sessionEntry({ inFlight: [{ since: Date.now(), token: 'live-token' }] }),
    );
    await store.purgeChatSessions(IDENTITY);
    await store.clearInFlight(IDENTITY, AGENT, 'live-token');
    await store.recordCompletion(IDENTITY, AGENT, 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(storage.map.size).toBe(0);
  });
});

describe('subscription', () => {
  it('bumps the version on writes and skips no-ops', async () => {
    const { store } = createStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    expect(store.version()).toBe(0);
    await store.resolveSessionForSend(IDENTITY, AGENT, []);
    expect(store.version()).toBe(1);
    expect(notified).toBe(1);
    // No-create no-ops never notify.
    await store.recordCompletion(IDENTITY, OTHER_AGENT, 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(store.version()).toBe(1);
    unsubscribe();
    await store.rotateSession(IDENTITY, AGENT);
    expect(store.version()).toBe(2);
    expect(notified).toBe(1);
  });
});

describe('corrupt storage tolerance', () => {
  it('treats unparseable or malformed values as absent', async () => {
    const { store, storage } = createStore();
    storage.map.set(chatSessionKey(IDENTITY, AGENT), 'not-json{');
    expect(store.readChatSession(IDENTITY, AGENT)).toBeUndefined();
    storage.map.set(chatSessionKey(IDENTITY, AGENT), JSON.stringify({ sessionId: 42 }));
    expect(store.readChatSession(IDENTITY, AGENT)).toBeUndefined();
    // A malformed inFlight collection degrades to empty, not a parse failure.
    storage.map.set(
      chatSessionKey(IDENTITY, AGENT),
      JSON.stringify({ ...sessionEntry(), inFlight: [{ bad: true }, null, 'nope'] }),
    );
    expect(store.readChatSession(IDENTITY, AGENT)?.inFlight).toEqual([]);
    // And a corrupt entry behaves as absent for the never-create rule.
    storage.map.set(chatSessionKey(IDENTITY, AGENT), 'not-json{');
    expect(
      await store.recordCompletion(IDENTITY, AGENT, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toBe(false);
  });
});
