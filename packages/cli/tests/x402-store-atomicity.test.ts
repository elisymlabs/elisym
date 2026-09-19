/**
 * The x402 bridge's two writes must take their fragments with them.
 *
 * Both go through `${path}.tmp.${hex}` and rename, and the comment beside the
 * first says it is "cleaned up like every other temporary here" - a claim about
 * a whole class, which is exactly the kind this branch has been made to
 * measure rather than assert. Nothing swept these two: the index fragment is
 * visited by no cleanup at all (`sweepStrandedTemporaries` walks the RESULTS
 * directory only), and its content is the record of which upstream calls this
 * bridge has already paid for.
 *
 * Lives in its own file because it mocks `node:fs/promises`, the same shape as
 * `ledger-flush-atomicity.test.ts` and `session-write-atomicity.test.ts`: a
 * failure BETWEEN the write and the rename is what the cleanup exists for, and
 * no healthy filesystem produces one on demand.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make a write to a `.tmp.` path fail once it has left a fragment. */
let tempWriteFailure: Error | null = null;
/** Bytes the failing write put down, and the bytes it was asked for. */
let partialBytes = 0;
let fullBytes = 0;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises');
  return {
    ...actual,
    default: actual,
    writeFile: async (path: string, data: string | Uint8Array, options?: unknown) => {
      // Only the temporaries: the store seeds real files through this same
      // function, and a lever that fails those measures nothing.
      if (tempWriteFailure && String(path).includes('.tmp.')) {
        const half = Math.floor((typeof data === 'string' ? data.length : data.byteLength) / 2);
        const partial = typeof data === 'string' ? data.slice(0, half) : data.subarray(0, half);
        fullBytes = typeof data === 'string' ? data.length : data.byteLength;
        partialBytes = half;
        await actual.writeFile(path, partial, options as Parameters<typeof actual.writeFile>[2]);
        throw tempWriteFailure;
      }
      return actual.writeFile(path, data, options as Parameters<typeof actual.writeFile>[2]);
    },
  };
});

const { X402JobStore } = await import('../src/x402/store.js');

let agentDir: string;

beforeEach(() => {
  tempWriteFailure = null;
  partialBytes = 0;
  fullBytes = 0;
  agentDir = mkdtempSync(join(tmpdir(), 'elisym-x402-atomic-'));
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  tempWriteFailure = null;
  rmSync(agentDir, { recursive: true, force: true });
});

function fragmentsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.tmp.'));
}

describe('an x402 write that fails part way through', () => {
  it('leaves no fragment of the paid-attempt index behind', async () => {
    // Nothing ever visits this one: the store's own sweep walks the results
    // directory, and the name is random, so a stranded copy of the index -
    // which upstream calls were paid for, and what they returned - would sit
    // beside the real file until somebody deleted the agent.
    const store = new X402JobStore(agentDir);
    await store.claimPaidAttempt('job-1', 2, 2);

    tempWriteFailure = new Error('ENOSPC: no space left on device, write');
    await expect(store.claimPaidAttempt('job-2', 2, 2)).rejects.toThrow(/ENOSPC/);

    // The lever really did leave a FRAGMENT, not a whole file the cleanup then
    // tidied away - without these two the claim goes quietly untrue the next
    // time somebody edits the mock.
    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(fullBytes);
    expect(fragmentsIn(agentDir)).toEqual([]);
  });

  it('leaves no fragment of a bought RESULT behind', async () => {
    // This write happens after the upstream has been paid, so the fragment is a
    // partial copy of something the customer's money already bought. The TTL
    // sweep would reach it eventually; the cleanup is what keeps it from being
    // readable in the meantime.
    const store = new X402JobStore(agentDir);
    await store.claimPaidAttempt('job-1', 2, 2);

    tempWriteFailure = new Error('EIO: i/o error, write');
    await expect(
      store.saveFileResult('job-1', 'image/png', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    ).rejects.toThrow(/EIO/);

    expect(partialBytes).toBeGreaterThan(0);
    expect(partialBytes).toBeLessThan(fullBytes);
    expect(fragmentsIn(join(agentDir, '.x402-results'))).toEqual([]);
  });
});
