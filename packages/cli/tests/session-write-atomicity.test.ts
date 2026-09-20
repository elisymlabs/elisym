/**
 * A session rewrite that fails must take its fragment with it.
 *
 * Both rewrites - the torn-line repair on open, and the compaction that runs
 * mid-conversation - go through `${path}.tmp.${hex}` and rename. The name is
 * random, so nothing ever reuses or sweeps a leftover: a write that dies part
 * way through would strand a partial copy of the transcript for good, under a
 * name no `.gitignore` entry and no cleanup ever visits. What a transcript
 * holds is the customer's prompts and the provider's answers in the clear.
 *
 * Lives in its own file because it mocks `node:fs`, the same shape as
 * `ledger-flush-atomicity.test.ts` - a failure BETWEEN the write and the
 * rename is what the cleanup exists for, and no healthy filesystem produces
 * one on demand.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make a write to a `.tmp.` path fail once it has left a fragment. */
let tempWriteFailure: Error | null = null;
/** Bytes the failing write put down, and the bytes it was asked for. */
let partialBytes = 0;
let fullBytes = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    default: actual,
    writeFileSync: (path: string, data: string, options?: unknown) => {
      // Only the temporaries: the fixture has to seed real files through this
      // same function, and a lever that fails those measures nothing.
      if (tempWriteFailure && String(path).includes('.tmp.')) {
        const partial = data.slice(0, Math.floor(data.length / 2));
        fullBytes = data.length;
        partialBytes = partial.length;
        actual.writeFileSync(path, partial, options as Parameters<typeof actual.writeFileSync>[2]);
        throw tempWriteFailure;
      }
      return actual.writeFileSync(
        path,
        data,
        options as Parameters<typeof actual.writeFileSync>[2],
      );
    },
  };
});

const { SESSIONS_DIR_NAME, SessionStore } = await import('../src/sessions.js');

const CUSTOMER = 'a'.repeat(64);
const SID = '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c';

let agentDir: string;
let sessionDir: string;

function turn(role: 'user' | 'assistant', content: string): string {
  return JSON.stringify({ type: 'turn', role, content, jobId: 'job-1', ts: 1 });
}

beforeEach(() => {
  tempWriteFailure = null;
  partialBytes = 0;
  fullBytes = 0;
  agentDir = mkdtempSync(join(tmpdir(), 'elisym-session-atomic-'));
  sessionDir = join(agentDir, SESSIONS_DIR_NAME, CUSTOMER);
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  tempWriteFailure = null;
  rmSync(agentDir, { recursive: true, force: true });
});

function fragments(): string[] {
  return readdirSync(sessionDir).filter((name) => name.includes('.tmp.'));
}

describe('a session rewrite that fails part way through', () => {
  it('leaves no fragment behind when the torn-line repair fails', async () => {
    const path = join(sessionDir, `${SID}.jsonl`);
    writeFileSync(
      path,
      `${turn('user', 'hello')}\n${turn('assistant', 'hi')}\n{"type":"turn","role":"assi`,
      'utf-8',
    );
    const store = new SessionStore(agentDir);
    store.init();

    tempWriteFailure = new Error('ENOSPC: no space left on device, write');
    const release = await store.acquire(CUSTOMER, SID);
    try {
      expect(() => store.open(CUSTOMER, SID)).toThrow(/ENOSPC/);
    } finally {
      release();
    }

    // The lever really did leave a FRAGMENT rather than a whole file the
    // cleanup then tidied away - without these two the claim goes untrue the
    // next time somebody edits the mock.
    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(fullBytes);
    expect(fragments()).toEqual([]);
  });

  it('leaves no fragment behind when the compaction rewrite fails', async () => {
    const store = new SessionStore(agentDir, undefined, {
      compactionTriggerChars: 200,
      compactionKeepChars: 80,
    });
    store.init();
    const release = await store.acquire(CUSTOMER, SID);
    try {
      store.appendExchange(CUSTOMER, SID, {
        jobId: 'job-1',
        capability: 'chat',
        userContent: 'x'.repeat(100),
        assistantContent: 'y'.repeat(100),
        skipRoles: new Set(),
      });

      tempWriteFailure = new Error('EIO: i/o error, write');
      expect(() => store.compact(CUSTOMER, SID, 'the summary')).toThrow(/EIO/);
    } finally {
      release();
    }

    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(fullBytes);
    expect(fragments()).toEqual([]);
  });
});
