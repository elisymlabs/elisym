/**
 * Thread-store tests (stage 2 design, `chatThread.ts`): serialized RMW via the
 * per-key queue, subscription/version, outcome transitions strict
 * update-if-present (never resurrect), hydration merge semantics (atomic
 * completion, idempotent double-completion, stamp/lifecycle fields never
 * clobbered), 500-entry cap with the paid-pending exemption, unpaid aging, and
 * the entry-level identity purge primitive.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_THREAD_KEY_PREFIX,
  chatThreadKey,
  createChatThreadStore,
  MAX_THREAD_ENTRIES,
  type ChatThreadEntry,
  type ChatThreadStorageAdapter,
  type HydratedChatEntry,
} from '../app/lib/chatThread';
import type { LocksAdapter } from '../app/lib/locks';

const AGENT = 'agent-pubkey-1';
const OTHER_AGENT = 'agent-pubkey-2';
const IDENTITY_A = 'identity-a';
const IDENTITY_B = 'identity-b';
const SESSION_UUID = '01234567-89ab-4cde-8f01-23456789abcd';

interface MemoryThreadStorage extends ChatThreadStorageAdapter {
  map: Map<string, ChatThreadEntry[]>;
}

/**
 * In-memory adapter mimicking `cacheUpdate`'s contract (single RMW, undefined
 * deletes). `delayMs` > 0 opens a read-then-write window inside `update` so a
 * broken serialization would manifest as a lost update.
 */
function createMemoryStorage(delayMs = 0): MemoryThreadStorage {
  const map = new Map<string, ChatThreadEntry[]>();
  const wait = () =>
    delayMs > 0
      ? new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        })
      : Promise.resolve();
  return {
    map,
    async get(key) {
      return map.get(key);
    },
    async update(key, updater) {
      const current = map.get(key);
      await wait();
      const next = updater(current === undefined ? undefined : [...current]);
      if (next === undefined) {
        map.delete(key);
      } else {
        map.set(key, next);
      }
      return true;
    },
    async listKeys(predicate) {
      return [...map.keys()].filter(predicate);
    },
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

function pendingEntry(
  jobEventId: string,
  overrides: Partial<Omit<ChatThreadEntry, 'status'>> = {},
): Omit<ChatThreadEntry, 'status'> {
  return {
    jobEventId,
    customerPubkey: IDENTITY_A,
    capability: 'echo',
    prompt: `prompt ${jobEventId}`,
    ts: Date.now(),
    ...overrides,
  };
}

function hydratedEntry(
  jobEventId: string,
  overrides: Partial<HydratedChatEntry> = {},
): HydratedChatEntry {
  return {
    jobEventId,
    customerPubkey: IDENTITY_A,
    capability: 'echo',
    prompt: `prompt ${jobEventId}`,
    result: `result ${jobEventId}`,
    ts: Date.now(),
    ...overrides,
  };
}

function createStore(delayMs = 0) {
  const storage = createMemoryStorage(delayMs);
  const locks = createRecordingLocks();
  const store = createChatThreadStore(storage, locks);
  return { storage, locks, store };
}

describe('chatThread store', () => {
  it('appends a pending entry and reads it back', async () => {
    const { store } = createStore();
    await store.appendPendingEntry(AGENT, pendingEntry('job-1', { sessionId: SESSION_UUID }));
    const thread = await store.readThread(AGENT);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({
      jobEventId: 'job-1',
      customerPubkey: IDENTITY_A,
      sessionId: SESSION_UUID,
      status: 'pending',
    });
  });

  it('acquires the navigator.locks mutex under the store key name', async () => {
    const { store, locks } = createStore();
    await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
    expect(locks.names).toEqual([chatThreadKey(AGENT)]);
    expect(chatThreadKey(AGENT)).toBe(`${CHAT_THREAD_KEY_PREFIX}${AGENT}`);
  });

  it('serializes concurrent writes through the per-key queue (no lost updates)', async () => {
    const { store } = createStore(2);
    const jobIds = Array.from({ length: 20 }, (_, index) => `job-${index}`);
    await Promise.all(
      jobIds.map((jobEventId) => store.appendPendingEntry(AGENT, pendingEntry(jobEventId))),
    );
    const thread = await store.readThread(AGENT);
    expect(thread.map((entry) => entry.jobEventId).sort()).toEqual([...jobIds].sort());
  });

  it('serializes a concurrent append + completion (the transition is never lost)', async () => {
    const { store } = createStore(2);
    await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
    const [, fired] = await Promise.all([
      store.appendPendingEntry(AGENT, pendingEntry('job-2')),
      store.completeEntry(AGENT, 'job-1', { result: 'done' }),
    ]);
    expect(fired).toBe(true);
    const thread = await store.readThread(AGENT);
    expect(thread).toHaveLength(2);
    const completed = thread.find((entry) => entry.jobEventId === 'job-1');
    expect(completed?.status).toBeUndefined();
    expect(completed?.result).toBe('done');
  });

  it('bumps the version and notifies subscribers on every write, not on no-ops', async () => {
    const { store } = createStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    expect(store.version()).toBe(0);
    await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
    expect(store.version()).toBe(1);
    expect(notified).toBe(1);
    // A transition that does not fire must not bump.
    await store.completeEntry(AGENT, 'missing-job', { result: 'x' });
    expect(store.version()).toBe(1);
    expect(notified).toBe(1);
    await store.completeEntry(AGENT, 'job-1', { result: 'done' });
    expect(store.version()).toBe(2);
    expect(notified).toBe(2);
    unsubscribe();
    await store.appendPendingEntry(AGENT, pendingEntry('job-2'));
    expect(store.version()).toBe(3);
    expect(notified).toBe(2);
  });

  describe('outcome transitions (strict update-if-present)', () => {
    it('completes a pending entry atomically: result set and status cleared in one update', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      const fired = await store.completeEntry(AGENT, 'job-1', {
        result: 'answer',
        resultAttachments: [],
      });
      expect(fired).toBe(true);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.result).toBe('answer');
      expect(entry?.status).toBeUndefined();
      expect('status' in (entry ?? {})).toBe(false);
    });

    it('completes a failed entry (late crash-recovery result flips failed to completed)', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      await store.failEntry(AGENT, 'job-1');
      const fired = await store.completeEntry(AGENT, 'job-1', { result: 'late answer' });
      expect(fired).toBe(true);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.status).toBeUndefined();
      expect(entry?.result).toBe('late answer');
    });

    it('returns false on an already-completed entry (double completion is idempotent)', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      expect(await store.completeEntry(AGENT, 'job-1', { result: 'answer' })).toBe(true);
      expect(await store.completeEntry(AGENT, 'job-1', { result: 'answer' })).toBe(false);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.result).toBe('answer');
    });

    it('never inserts on a completion for an unknown job', async () => {
      const { store } = createStore();
      expect(await store.completeEntry(AGENT, 'ghost-job', { result: 'x' })).toBe(false);
      expect(await store.readThread(AGENT)).toEqual([]);
    });

    it('fails only pending entries; failed and completed entries return false', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      expect(await store.failEntry(AGENT, 'job-1')).toBe(true);
      expect(await store.failEntry(AGENT, 'job-1')).toBe(false);
      await store.completeEntry(AGENT, 'job-1', { result: 'answer' });
      // A completed entry is never demoted back to failed.
      expect(await store.failEntry(AGENT, 'job-1')).toBe(false);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.status).toBeUndefined();
      expect(await store.failEntry(AGENT, 'ghost-job')).toBe(false);
    });

    it('does not resurrect a purged entry via a late transition', async () => {
      const { store, storage } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      await store.purgeIdentityThreadEntries(IDENTITY_A);
      expect(await store.completeEntry(AGENT, 'job-1', { result: 'late' })).toBe(false);
      expect(await store.failEntry(AGENT, 'job-1')).toBe(false);
      expect(await store.readThread(AGENT)).toEqual([]);
      expect(storage.map.has(chatThreadKey(AGENT))).toBe(false);
    });

    it('records a txHash update-if-present only', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      expect(await store.recordEntryTxHash(AGENT, 'job-1', 'sig-1')).toBe(true);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.txHash).toBe('sig-1');
      expect(await store.recordEntryTxHash(AGENT, 'ghost-job', 'sig-2')).toBe(false);
      expect(await store.readThread(AGENT)).toHaveLength(1);
    });
  });

  describe('hydration merge', () => {
    it('inserts a completed stamped entry when nothing is stored (no transition fired)', async () => {
      const { store } = createStore();
      const outcome = await store.mergeHydratedEntry(
        AGENT,
        hydratedEntry('job-1', { sessionId: SESSION_UUID }),
      );
      expect(outcome).toEqual({ completedTransitionFired: false, sessionId: SESSION_UUID });
      const [entry] = await store.readThread(AGENT);
      expect(entry?.status).toBeUndefined();
      expect(entry?.customerPubkey).toBe(IDENTITY_A);
      expect(entry?.result).toBe('result job-1');
    });

    it('completes a stored pending entry atomically and reports the transition', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1', { sessionId: SESSION_UUID }));
      const outcome = await store.mergeHydratedEntry(AGENT, hydratedEntry('job-1'));
      expect(outcome.completedTransitionFired).toBe(true);
      expect(outcome.sessionId).toBe(SESSION_UUID);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.status).toBeUndefined();
      expect(entry?.result).toBe('result job-1');
    });

    it('completes a stored failed entry (provider finished after the local failure)', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      await store.failEntry(AGENT, 'job-1');
      const outcome = await store.mergeHydratedEntry(AGENT, hydratedEntry('job-1'));
      expect(outcome.completedTransitionFired).toBe(true);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.status).toBeUndefined();
      expect(entry?.result).toBe('result job-1');
    });

    it('is idempotent: a second merge of the same result fires no transition and changes nothing', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      const first = await store.mergeHydratedEntry(AGENT, hydratedEntry('job-1'));
      expect(first.completedTransitionFired).toBe(true);
      const versionAfterFirst = store.version();
      const second = await store.mergeHydratedEntry(AGENT, hydratedEntry('job-1'));
      expect(second.completedTransitionFired).toBe(false);
      expect(store.version()).toBe(versionAfterFirst);
      expect(await store.readThread(AGENT)).toHaveLength(1);
    });

    it('never clobbers the local txHash on completion', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1'));
      await store.recordEntryTxHash(AGENT, 'job-1', 'paid-sig');
      const outcome = await store.mergeHydratedEntry(AGENT, hydratedEntry('job-1'));
      expect(outcome.completedTransitionFired).toBe(true);
      const [entry] = await store.readThread(AGENT);
      expect(entry?.txHash).toBe('paid-sig');
      expect(entry?.status).toBeUndefined();
    });

    it('never clobbers the deliberate sessionId: null one-shot marker', async () => {
      const { store } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-1', { sessionId: null }));
      const outcome = await store.mergeHydratedEntry(
        AGENT,
        hydratedEntry('job-1', { sessionId: SESSION_UUID }),
      );
      expect(outcome.completedTransitionFired).toBe(true);
      // The one-shot marker survives, so no session UUID is reported.
      expect(outcome.sessionId).toBeUndefined();
      const [entry] = await store.readThread(AGENT);
      expect(entry?.sessionId).toBeNull();
    });

    it('upgrades a stored completed entry in place: fills only missing fields', async () => {
      const { store } = createStore();
      await store.mergeHydratedEntry(AGENT, hydratedEntry('job-1', { result: 'original' }));
      const outcome = await store.mergeHydratedEntry(
        AGENT,
        hydratedEntry('job-1', {
          customerPubkey: IDENTITY_B,
          sessionId: SESSION_UUID,
          priceLamports: 5000,
          result: 'rewritten',
        }),
      );
      expect(outcome.completedTransitionFired).toBe(false);
      const [entry] = await store.readThread(AGENT);
      // Missing fields filled...
      expect(entry?.sessionId).toBe(SESSION_UUID);
      expect(entry?.priceLamports).toBe(5000);
      // ...but present fields, above all the identity stamp, never overwritten.
      expect(entry?.customerPubkey).toBe(IDENTITY_A);
      expect(entry?.result).toBe('original');
    });
  });

  describe('cap', () => {
    it('trims oldest-by-ts entries over the cap on write', async () => {
      const { store } = createStore();
      const base = Date.now() - 1_000_000;
      for (let i = 0; i < MAX_THREAD_ENTRIES; i += 1) {
        await store.mergeHydratedEntry(AGENT, hydratedEntry(`job-${i}`, { ts: base + i }));
      }
      await store.mergeHydratedEntry(AGENT, hydratedEntry('job-newest', { ts: base + 999_999 }));
      const thread = await store.readThread(AGENT);
      expect(thread).toHaveLength(MAX_THREAD_ENTRIES);
      expect(thread.some((entry) => entry.jobEventId === 'job-0')).toBe(false);
      expect(thread.some((entry) => entry.jobEventId === 'job-newest')).toBe(true);
    });

    it('exempts paid pending entries from the trim', async () => {
      const { store } = createStore();
      const base = Date.now() - 1_000_000;
      // The OLDEST entry is paid pending - it must survive the trim.
      await store.appendPendingEntry(
        AGENT,
        pendingEntry('job-paid', { ts: base - 10, txHash: 'paid-sig' }),
      );
      for (let i = 0; i < MAX_THREAD_ENTRIES; i += 1) {
        await store.mergeHydratedEntry(AGENT, hydratedEntry(`job-${i}`, { ts: base + i }));
      }
      const thread = await store.readThread(AGENT);
      expect(thread).toHaveLength(MAX_THREAD_ENTRIES);
      expect(thread.some((entry) => entry.jobEventId === 'job-paid')).toBe(true);
      // The oldest NON-exempt entry was trimmed instead.
      expect(thread.some((entry) => entry.jobEventId === 'job-0')).toBe(false);
    });
  });

  describe('unpaid aging', () => {
    it('ages only unpaid pending entries older than maxAgeMs to failed', async () => {
      const { store } = createStore();
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      await store.appendPendingEntry(
        AGENT,
        pendingEntry('job-old-unpaid', { ts: now - 2 * dayMs }),
      );
      await store.appendPendingEntry(
        AGENT,
        pendingEntry('job-old-paid', { ts: now - 2 * dayMs, txHash: 'paid-sig' }),
      );
      await store.appendPendingEntry(AGENT, pendingEntry('job-fresh', { ts: now }));
      await store.mergeHydratedEntry(AGENT, hydratedEntry('job-done', { ts: now - 2 * dayMs }));

      const aged = await store.agePendingEntries(AGENT, dayMs);
      expect(aged.map((entry) => entry.jobEventId)).toEqual(['job-old-unpaid']);
      expect(aged[0]?.status).toBe('failed');

      const thread = await store.readThread(AGENT);
      const byId = new Map(thread.map((entry) => [entry.jobEventId, entry]));
      expect(byId.get('job-old-unpaid')?.status).toBe('failed');
      // Paid pending stays pending indefinitely by design.
      expect(byId.get('job-old-paid')?.status).toBe('pending');
      expect(byId.get('job-fresh')?.status).toBe('pending');
      expect(byId.get('job-done')?.status).toBeUndefined();
    });

    it('returns an empty list when nothing ages (idempotent re-run)', async () => {
      const { store } = createStore();
      const dayMs = 24 * 60 * 60 * 1000;
      await store.appendPendingEntry(AGENT, pendingEntry('job-1', { ts: Date.now() - 2 * dayMs }));
      expect(await store.agePendingEntries(AGENT, dayMs)).toHaveLength(1);
      const versionAfterAging = store.version();
      expect(await store.agePendingEntries(AGENT, dayMs)).toEqual([]);
      expect(store.version()).toBe(versionAfterAging);
    });
  });

  describe('identity purge', () => {
    it('removes only the purged identity entries across every agent thread', async () => {
      const { store, storage, locks } = createStore();
      await store.appendPendingEntry(AGENT, pendingEntry('job-a1', { customerPubkey: IDENTITY_A }));
      await store.appendPendingEntry(AGENT, pendingEntry('job-b1', { customerPubkey: IDENTITY_B }));
      await store.appendPendingEntry(
        OTHER_AGENT,
        pendingEntry('job-a2', { customerPubkey: IDENTITY_A }),
      );

      await store.purgeIdentityThreadEntries(IDENTITY_A);

      const thread = await store.readThread(AGENT);
      expect(thread.map((entry) => entry.jobEventId)).toEqual(['job-b1']);
      // A thread emptied by the purge deletes its key outright.
      expect(storage.map.has(chatThreadKey(OTHER_AGENT))).toBe(false);
      // Filter-rewrites ran under the same per-key locks as every writer.
      expect(locks.names.filter((name) => name === chatThreadKey(AGENT)).length).toBeGreaterThan(1);
      expect(locks.names).toContain(chatThreadKey(OTHER_AGENT));
    });
  });
});
