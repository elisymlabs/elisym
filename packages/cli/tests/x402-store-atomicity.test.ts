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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make a write to a `.tmp.` path fail once it has left a fragment. */
let tempWriteFailure: Error | null = null;
/** Set to hold a write to a `.tmp.` path open until it is released. */
let heldTempWrite: Promise<void> | null = null;
/** How many times the sweep has been allowed to look at the directory. */
let directoryReads = 0;
/** Bytes the failing write put down, and the bytes it was asked for. */
let partialBytes = 0;
let fullBytes = 0;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs/promises');
  return {
    ...actual,
    default: actual,
    readdir: async (path: string) => {
      directoryReads += 1;
      return actual.readdir(path);
    },
    writeFile: async (path: string, data: string | Uint8Array, options?: unknown) => {
      if (heldTempWrite && String(path).includes('.tmp.')) {
        // The temporary exists, and the rename has not happened yet - the
        // window a sweep must not run in.
        await actual.writeFile(path, data, options as Parameters<typeof actual.writeFile>[2]);
        await heldTempWrite;
        return undefined;
      }
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
  heldTempWrite = null;
  directoryReads = 0;
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

  it('sweeps an index fragment a crash left behind, which nothing else visits', async () => {
    // The cleanup above only runs when the write THROWS. A process killed
    // outright leaves the fragment, and it is tied to no record, so the
    // per-record sweep could never reach it - its directory is the agent root,
    // not the results folder.
    const store = new X402JobStore(agentDir);
    await store.claimPaidAttempt('job-1', 2, 2);
    const stranded = join(agentDir, '.x402-jobs.json.tmp.deadbeefcafe');
    writeFileSync(stranded, '{"job-1":{"attempts":1}}', 'utf-8');

    await store.sweepExpired();

    expect(fragmentsIn(agentDir)).toEqual([]);
    // And the real index is untouched: the sweep matches the temporary's
    // prefix, not the file it is a temporary OF.
    expect(await new X402JobStore(agentDir).paidAttempts('job-1')).toBe(1);
  });

  it('does not even LOOK at the directory while a writer holds the queue', async () => {
    // The sweep is unconditional - an index fragment belongs to no record - so
    // its PLACEMENT is the only thing keeping it from deleting the temporary a
    // concurrent `save` is about to rename, which would fail that rename with
    // ENOENT on a write that was perfectly healthy.
    //
    // Asserted as ORDER rather than as an outcome: whether a sweep outside the
    // queue wins the race depends on the clock, and a fixture that depends on
    // the clock measures the clock. Inside the queue it cannot run at all until
    // the writer is done - that is checkable exactly.
    const store = new X402JobStore(agentDir);
    await store.claimPaidAttempt('job-1', 2, 2);

    let release: () => void = () => undefined;
    heldTempWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = store.claimPaidAttempt('job-2', 2, 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    directoryReads = 0;

    const sweeping = store.sweepExpired();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(directoryReads).toBe(0);

    release();
    heldTempWrite = null;
    await saving;
    await sweeping;

    expect(directoryReads).toBeGreaterThan(0);
    expect(await new X402JobStore(agentDir).paidAttempts('job-2')).toBe(1);
  });

  it('sweeps the BARE name an older build left, not only the random one', async () => {
    // The upgrade case: before this branch the temporary had one fixed name and
    // the next write reused it, so a fragment bounded itself. A random suffix
    // removes that accident - and a sweep matching only the new shape would
    // leave an older build's copy of the paid-attempt index sitting here for
    // good.
    const store = new X402JobStore(agentDir);
    await store.claimPaidAttempt('job-1', 2, 2);
    writeFileSync(join(agentDir, '.x402-jobs.json.tmp'), '{"job-1":{"attempts":1}}', 'utf-8');

    await store.sweepExpired();

    expect(readdirSync(agentDir).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(await new X402JobStore(agentDir).paidAttempts('job-1')).toBe(1);
  });
});
