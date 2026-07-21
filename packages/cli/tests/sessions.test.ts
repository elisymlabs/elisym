import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_CONTEXT_UNAVAILABLE,
  SESSION_SUMMARY_PREFIX,
  SESSIONS_DIR_NAME,
  SessionStore,
} from '../src/sessions.js';

const CUSTOMER = 'a'.repeat(64);
const OTHER_CUSTOMER = 'b'.repeat(64);
const SID = '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c';
const SID2 = '4a1b2c3d-5e6f-4a7b-9c8d-0e1f2a3b4c5d';

let agentDir: string;

function makeStore(tuning?: ConstructorParameters<typeof SessionStore>[2]): SessionStore {
  const store = new SessionStore(agentDir, undefined, tuning);
  store.init();
  return store;
}

function sessionPath(customer: string, sessionId: string): string {
  return join(agentDir, SESSIONS_DIR_NAME, customer, `${sessionId}.jsonl`);
}

/** Record one full exchange under the mutex, the way the runtime does. */
async function record(
  store: SessionStore,
  jobId: string,
  user: string,
  assistant: string,
  customer = CUSTOMER,
  sessionId = SID,
): Promise<void> {
  const release = await store.acquire(customer, sessionId);
  try {
    const opened = store.open(customer, sessionId);
    if (!opened.stateless) {
      store.appendExchange(customer, sessionId, {
        jobId,
        capability: 'chat',
        userContent: user,
        assistantContent: assistant,
        skipRoles: opened.recordedRoles,
      });
    }
  } finally {
    release();
  }
}

/** Backdate a session file's mtime by `ageMs`. */
function backdate(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'elisym-sessions-'));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe('SessionStore - transcript basics', () => {
  it('round-trips an exchange into replayable history', async () => {
    const store = makeStore();
    await record(store, 'job1', 'hello', 'hi there');
    const opened = store.open(CUSTOMER, SID);
    expect(opened.known).toBe(true);
    expect(opened.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('keeps sessions isolated per customer (same session id)', async () => {
    const store = makeStore();
    await record(store, 'job1', 'secret question', 'secret answer', CUSTOMER, SID);
    const opened = store.open(OTHER_CUSTOMER, SID);
    expect(opened.known).toBe(false);
    expect(opened.messages).toEqual([]);
  });

  it('rejects path-traversal-shaped keys', () => {
    const store = makeStore();
    expect(() => store.open('../evil', SID)).toThrow(/invalid customer pubkey/);
    expect(() => store.open(CUSTOMER, '../../escape')).toThrow(/invalid session id/);
  });

  it('creates files 0o600 and dirs 0o700', async () => {
    const store = makeStore();
    await record(store, 'job1', 'q', 'a');
    const fileMode = statSync(sessionPath(CUSTOMER, SID)).mode & 0o777;
    const dirMode = statSync(join(agentDir, SESSIONS_DIR_NAME, CUSTOMER)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('truncates oversized turn content with a marker (both roles)', async () => {
    const store = makeStore({ maxTurnBytes: 64 });
    await record(store, 'job1', 'u'.repeat(500), 'a'.repeat(500));
    const opened = store.open(CUSTOMER, SID);
    expect(opened.messages[0]!.content.endsWith('[truncated]')).toBe(true);
    expect(opened.messages[1]!.content.endsWith('[truncated]')).toBe(true);
    expect(Buffer.byteLength(opened.messages[0]!.content)).toBeLessThanOrEqual(64);
  });

  it('recreates the customer dir on append after a sweep rmdir (ENOENT retry)', async () => {
    const store = makeStore();
    const release = await store.acquire(CUSTOMER, SID);
    try {
      const opened = store.open(CUSTOMER, SID);
      // Simulate the hourly sweep pruning the (still empty) customer dir
      // between open and append.
      rmSync(join(agentDir, SESSIONS_DIR_NAME, CUSTOMER), { recursive: true, force: true });
      store.appendExchange(CUSTOMER, SID, {
        jobId: 'job1',
        capability: 'chat',
        userContent: 'q',
        assistantContent: 'a',
        skipRoles: opened.recordedRoles,
      });
    } finally {
      release();
    }
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(true);
  });
});

describe('SessionStore - dedupe by (jobId, role)', () => {
  it('excludes the recovering job own turns from history and skips re-append', async () => {
    const store = makeStore();
    await record(store, 'job1', 'first q', 'first a');
    await record(store, 'job2', 'second q', 'second a');

    // Recovery of job2: history must not contain job2's own turns.
    const opened = store.open(CUSTOMER, SID, 'job2');
    expect(opened.messages).toEqual([
      { role: 'user', content: 'first q' },
      { role: 'assistant', content: 'first a' },
    ]);
    expect(opened.recordedRoles).toEqual(new Set(['user', 'assistant']));

    // Re-append with skipRoles: file must not grow.
    const before = readFileSync(sessionPath(CUSTOMER, SID), 'utf-8');
    store.appendExchange(CUSTOMER, SID, {
      jobId: 'job2',
      capability: 'chat',
      userContent: 'second q',
      assistantContent: 'diverged answer',
      skipRoles: opened.recordedRoles,
    });
    expect(readFileSync(sessionPath(CUSTOMER, SID), 'utf-8')).toBe(before);
  });

  it('appends only the missing role after a torn assistant line', async () => {
    const store = makeStore();
    await record(store, 'job1', 'q1', 'a1');
    // Simulate a torn append: a user line for job2 lands, assistant line torn.
    appendFileSync(
      sessionPath(CUSTOMER, SID),
      JSON.stringify({ type: 'turn', role: 'user', content: 'q2', jobId: 'job2', ts: 1 }) +
        '\n{"type":"turn","role":"assist',
    );
    const opened = store.open(CUSTOMER, SID, 'job2');
    expect(opened.recordedRoles).toEqual(new Set(['user']));
    store.appendExchange(CUSTOMER, SID, {
      jobId: 'job2',
      capability: 'chat',
      userContent: 'q2',
      assistantContent: 'a2',
      skipRoles: opened.recordedRoles,
    });
    const reopened = store.open(CUSTOMER, SID);
    expect(reopened.messages.map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });
});

describe('SessionStore - replay assembler', () => {
  function writeLines(lines: unknown[], customer = CUSTOMER, sessionId = SID): void {
    const dir = join(agentDir, SESSIONS_DIR_NAME, customer);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      sessionPath(customer, sessionId),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      { mode: 0o600 },
    );
  }

  function turn(role: 'user' | 'assistant', content: string, jobId: string) {
    return { type: 'turn', role, content, jobId, ts: 1 };
  }

  it('replays the summary as a marked first user message', () => {
    const store = makeStore();
    const dir = join(agentDir, SESSIONS_DIR_NAME, CUSTOMER);
    void dir;
    writeLines([
      { type: 'summary', content: 'earlier stuff', ts: 1 },
      turn('user', 'q', 'j1'),
      turn('assistant', 'a', 'j1'),
    ]);
    const opened = store.open(CUSTOMER, SID);
    // summary-user and q-user are same-role neighbors -> merged client-side.
    expect(opened.messages).toEqual([
      { role: 'user', content: `${SESSION_SUMMARY_PREFIX}\nearlier stuff\n\nq` },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('skips empty turns, drops leading assistant and trailing user messages', () => {
    const store = makeStore();
    writeLines([
      turn('assistant', 'orphan lead', 'j0'),
      turn('user', 'q1', 'j1'),
      turn('assistant', '', 'j1'), // empty output - stored empty, skipped at replay
      turn('user', 'q2', 'j2'),
    ]);
    const opened = store.open(CUSTOMER, SID);
    // q1's empty answer is skipped; q1+q2 would both trail as user -> dropped.
    expect(opened.messages).toEqual([]);
  });

  it('drops a summary-only history to empty (would end user-role)', () => {
    const store = makeStore();
    writeLines([{ type: 'summary', content: 'only summary', ts: 1 }]);
    const opened = store.open(CUSTOMER, SID);
    expect(opened.messages).toEqual([]);
  });

  it('merges consecutive same-role messages with a blank line', () => {
    const store = makeStore();
    writeLines([
      turn('user', 'part one', 'j1'),
      turn('user', 'part two', 'j2'),
      turn('assistant', 'answer', 'j2'),
    ]);
    const opened = store.open(CUSTOMER, SID);
    expect(opened.messages).toEqual([
      { role: 'user', content: 'part one\n\npart two' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('tolerates a torn last line (crash mid-append)', () => {
    const store = makeStore();
    writeLines([turn('user', 'q', 'j1'), turn('assistant', 'a', 'j1')]);
    appendFileSync(sessionPath(CUSTOMER, SID), '{"type":"turn","ro');
    const opened = store.open(CUSTOMER, SID);
    expect(opened.messages).toHaveLength(2);
  });

  it('quarantines a mid-file corrupt line into a .corrupt sidecar and resets', () => {
    const store = makeStore();
    writeLines([turn('user', 'q', 'j1')]);
    appendFileSync(
      sessionPath(CUSTOMER, SID),
      'garbage-not-json\n' + JSON.stringify(turn('assistant', 'a', 'j1')) + '\n',
    );
    const opened = store.open(CUSTOMER, SID);
    expect(opened.known).toBe(false);
    expect(opened.messages).toEqual([]);
    const names = readdirSync(join(agentDir, SESSIONS_DIR_NAME, CUSTOMER));
    expect(names.some((name) => name.includes('.corrupt.'))).toBe(true);
  });
});

describe('SessionStore - compaction', () => {
  it('flags compaction past the trigger and compacts to [summary, kept tail]', async () => {
    const store = makeStore({ compactionTriggerChars: 200, compactionKeepChars: 80 });
    await record(store, 'j1', 'x'.repeat(100), 'y'.repeat(100));
    await record(store, 'j2', 'q recent', 'a recent');

    const opened = store.open(CUSTOMER, SID);
    expect(opened.compactionNeeded).toBe(true);
    expect(opened.summarizeText).toContain('x'.repeat(100));

    const messages = store.compact(CUSTOMER, SID, 'the summary');
    expect(messages[0]!.content).toBe(`${SESSION_SUMMARY_PREFIX}\nthe summary\n\nq recent`);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'a recent' });

    const reopened = store.open(CUSTOMER, SID);
    expect(reopened.compactionNeeded).toBe(false);
  });

  it('throws on an empty summary instead of rewriting', async () => {
    const store = makeStore({ compactionTriggerChars: 50, compactionKeepChars: 20 });
    await record(store, 'j1', 'x'.repeat(100), 'y'.repeat(100));
    expect(() => store.compact(CUSTOMER, SID, '   ')).toThrow(/empty summary/);
    // Transcript untouched.
    expect(store.open(CUSTOMER, SID).messages).toHaveLength(2);
  });

  it('force-truncates after two consecutive failures (canonical shape)', async () => {
    const store = makeStore({ compactionTriggerChars: 50, compactionKeepChars: 30 });
    await record(store, 'j1', 'old '.repeat(30), 'older '.repeat(30));
    await record(store, 'j2', 'recent q', 'recent a');

    expect(store.compactionFailed(CUSTOMER, SID)).toEqual({ forced: false });
    const second = store.compactionFailed(CUSTOMER, SID);
    expect(second.forced).toBe(true);
    expect(second.messages![0]!.content).toContain(SESSION_CONTEXT_UNAVAILABLE);
    expect(second.messages![0]!.content.startsWith(SESSION_SUMMARY_PREFIX)).toBe(true);

    // A successful compact resets the strike counter path (fresh strikes).
    expect(store.compactionFailed(CUSTOMER, SID)).toEqual({ forced: false });
  });

  it('truncates a floored oversized single turn during the rewrite', async () => {
    const store = makeStore({ compactionTriggerChars: 100, compactionKeepChars: 50 });
    await record(store, 'j1', 'q1', 'a'.repeat(400));
    const messages = store.compact(CUSTOMER, SID, 'sum');
    const tailTurn = messages[messages.length - 1]!;
    expect(tailTurn.content.length).toBeLessThanOrEqual(50 + '\n[truncated]'.length);
  });
});

describe('SessionStore - TTL, caps, and eviction', () => {
  it('load-time TTL check deletes the expired file before recording', async () => {
    const store = makeStore({ ttlMs: 60_000 });
    await record(store, 'j1', 'old q', 'old a');
    backdate(sessionPath(CUSTOMER, SID), 120_000);

    const opened = store.open(CUSTOMER, SID);
    expect(opened.known).toBe(false);
    expect(opened.messages).toEqual([]);
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(false);
  });

  it('gc sweeps expired sessions, prunes old sidecars, rmdirs empty dirs', async () => {
    const store = makeStore({ ttlMs: 60_000 });
    await record(store, 'j1', 'q', 'a');
    backdate(sessionPath(CUSTOMER, SID), 120_000);
    const sidecar = sessionPath(CUSTOMER, SID) + '.corrupt.123';
    writeFileSync(sidecar, 'junk');
    backdate(sidecar, 120_000);

    store.gc();
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(join(agentDir, SESSIONS_DIR_NAME, CUSTOMER))).toBe(false);
  });

  it('gc never deletes a session whose mutex is held or with admitted jobs', async () => {
    const store = makeStore({ ttlMs: 60_000 });
    await record(store, 'j1', 'q', 'a');
    await record(store, 'j2', 'q', 'a', CUSTOMER, SID2);
    backdate(sessionPath(CUSTOMER, SID), 120_000);
    backdate(sessionPath(CUSTOMER, SID2), 120_000);

    const release = await store.acquire(CUSTOMER, SID); // mutex held
    store.admitLive(CUSTOMER, SID2); // mid-payment (pre-mutex) job
    store.gc();
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(true);
    expect(existsSync(sessionPath(CUSTOMER, SID2))).toBe(true);

    release();
    store.releaseLive(CUSTOMER, SID2);
    store.gc();
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(false);
    expect(existsSync(sessionPath(CUSTOMER, SID2))).toBe(false);
  });

  it('per-customer cap LRU-evicts the oldest idle session for a new one', async () => {
    const store = makeStore({ maxPerCustomer: 2 });
    const sid3 = '5b2c3d4e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    await record(store, 'j1', 'q', 'a', CUSTOMER, SID);
    await record(store, 'j2', 'q', 'a', CUSTOMER, SID2);
    backdate(sessionPath(CUSTOMER, SID), 60_000); // SID is oldest

    await record(store, 'j3', 'q', 'a', CUSTOMER, sid3);
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(false);
    expect(existsSync(sessionPath(CUSTOMER, SID2))).toBe(true);
    expect(existsSync(sessionPath(CUSTOMER, sid3))).toBe(true);
  });

  it('per-customer cap with no evictable victim processes stateless', async () => {
    const store = makeStore({ maxPerCustomer: 1 });
    await record(store, 'j1', 'q', 'a', CUSTOMER, SID);
    store.admitLive(CUSTOMER, SID); // the only candidate is protected

    const release = await store.acquire(CUSTOMER, SID2);
    try {
      const opened = store.open(CUSTOMER, SID2);
      expect(opened.stateless).toBe(true);
    } finally {
      release();
      store.releaseLive(CUSTOMER, SID);
    }
  });

  it('global cap evicts oldest unreserved sessions, never self', async () => {
    // Seed two sessions with a permissive store, then re-open with a cap sized
    // from the REAL file sizes: total triggers eviction, and after evicting the
    // older session the survivor fits.
    const seed = makeStore();
    await record(seed, 'j1', 'q'.repeat(80), 'a'.repeat(80), OTHER_CUSTOMER, SID2);
    backdate(sessionPath(OTHER_CUSTOMER, SID2), 60_000);
    await record(seed, 'j2', 'w'.repeat(80), 'b'.repeat(80), CUSTOMER, SID);
    const otherSize = statSync(sessionPath(OTHER_CUSTOMER, SID2)).size;
    const ownSize = statSync(sessionPath(CUSTOMER, SID)).size;

    const store = new SessionStore(agentDir, undefined, {
      globalMaxBytes: otherSize + ownSize,
      globalEvictToBytes: ownSize,
    });
    store.init();
    const release = await store.acquire(CUSTOMER, SID);
    try {
      const opened = store.open(CUSTOMER, SID);
      expect(opened.stateless).toBe(false);
    } finally {
      release();
    }
    expect(existsSync(sessionPath(OTHER_CUSTOMER, SID2))).toBe(false);
    expect(existsSync(sessionPath(CUSTOMER, SID))).toBe(true);
  });

  it('global cap with no evictable victim processes stateless (no injection, no append)', async () => {
    const store = makeStore({ globalMaxBytes: 100, globalEvictToBytes: 90 });
    await record(store, 'j1', 'q'.repeat(80), 'a'.repeat(80), CUSTOMER, SID);
    store.admitLive(CUSTOMER, SID); // protect the only victim

    const release = await store.acquire(OTHER_CUSTOMER, SID2);
    try {
      const opened = store.open(OTHER_CUSTOMER, SID2);
      expect(opened.stateless).toBe(true);
    } finally {
      release();
      store.releaseLive(CUSTOMER, SID);
    }
    expect(existsSync(sessionPath(OTHER_CUSTOMER, SID2))).toBe(false);
  });
});

describe('SessionStore - admitted counter and mutex', () => {
  it('live admit/release round-trips on every path', () => {
    const store = makeStore();
    expect(store.admittedCount(CUSTOMER, SID)).toBe(0);
    store.admitLive(CUSTOMER, SID);
    store.admitLive(CUSTOMER, SID);
    expect(store.admittedCount(CUSTOMER, SID)).toBe(2);
    store.releaseLive(CUSTOMER, SID);
    store.releaseLive(CUSTOMER, SID);
    expect(store.admittedCount(CUSTOMER, SID)).toBe(0);
    // Extra release never goes negative.
    store.releaseLive(CUSTOMER, SID);
    expect(store.admittedCount(CUSTOMER, SID)).toBe(0);
  });

  it('recovery registrations are jobId-keyed, idempotent, and status-released', () => {
    const store = makeStore();
    const refs = [{ jobId: 'jobA', customerId: CUSTOMER, sessionId: SID }];
    let paid = true;

    store.syncRecoveryRegistrations(refs, () => paid);
    store.syncRecoveryRegistrations(refs, () => paid); // idempotent across ticks
    expect(store.admittedCount(CUSTOMER, SID)).toBe(1);

    // Entry leaves `paid` -> released even when the refs list is empty
    // (the release sweep runs on every tick, not only when entries pend).
    paid = false;
    store.syncRecoveryRegistrations([], () => paid);
    expect(store.admittedCount(CUSTOMER, SID)).toBe(0);
  });

  it('serializes same-session critical sections', async () => {
    const store = makeStore();
    const order: string[] = [];
    const first = store.acquire(CUSTOMER, SID).then(async (release) => {
      order.push('first-in');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first-out');
      release();
    });
    const second = store.acquire(CUSTOMER, SID).then((release) => {
      order.push('second-in');
      release();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
  });

  it('byte counter survives init() rescans (sidecars excluded)', async () => {
    const store = makeStore();
    await record(store, 'j1', 'q'.repeat(100), 'a'.repeat(100));
    writeFileSync(sessionPath(CUSTOMER, SID) + '.corrupt.1', 'x'.repeat(10_000));

    // A fresh store instance must count only the live session file.
    const fresh = new SessionStore(agentDir, undefined, {
      globalMaxBytes: 5000,
      globalEvictToBytes: 4000,
    });
    fresh.init();
    const release = await fresh.acquire(CUSTOMER, SID);
    try {
      // Under the cap despite the 10KB sidecar -> not stateless.
      expect(fresh.open(CUSTOMER, SID).stateless).toBe(false);
    } finally {
      release();
    }
  });
});
