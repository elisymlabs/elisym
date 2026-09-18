/**
 * `FileSettlementStore.write` must be all-or-nothing.
 *
 * `claim` reports `not-persisted` on the understanding that a failed write left
 * NOTHING on disk - that is what makes a refused claim safe to retry, and what
 * stops a signature from being reported as this job's while the index does not
 * hold it. Swallow the error instead and `claim` answers `claimed` about a
 * record that is not there: the job is delivered, the signature stays free, and
 * the next job settles the same transaction.
 *
 * Lives in its own file because it mocks `node:fs`, the same shape as
 * `packages/cli/tests/ledger-flush-atomicity.test.ts`. Without the mock only
 * the RETHROW is reached, by the locked-directory fixture next door: the
 * cleanup and the `prune` asymmetry need a failure BETWEEN the write and the
 * rename, which no healthy filesystem produces.
 *
 * And a note for whoever measures reachability next: `process.exit` is not a
 * usable probe here - it is a no-op in vitest's fork pool, measured. Append to
 * a marker file instead.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Set to make `chmodSync` fail, as a full disk or a hostile mode change would. */
let chmodFailure: Error | null = null;
/** Every path `chmodSync` was asked to change, in order. */
let chmodPaths: string[] = [];
/**
 * Set to make the WRITE fail after it has created the temporary, as ENOSPC
 * does. A separate lever from the chmod one because they fail at different
 * points: this one leaves a partial file where the chmod one leaves a complete
 * one, and only this one tells whether the write is inside the cleanup.
 */
let writeFailure: Error | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    chmodSync: (path: string, mode: number) => {
      chmodPaths.push(String(path));
      if (chmodFailure) {
        throw chmodFailure;
      }
      return actual.chmodSync(path, mode);
    },
    writeFileSync: (path: string, data: string, options?: unknown) => {
      const result = actual.writeFileSync(
        path as string,
        data,
        options as Parameters<typeof actual.writeFileSync>[2],
      );
      if (writeFailure) {
        throw writeFailure;
      }
      return result;
    },
  };
});

const { createFileSettlementStore } = await import('../src/payment/fileSettlementStore');
const { MIN_SETTLEMENT_RETENTION_MS } = await import('../src/payment/acceptor');

const SIG_A = 'A'.repeat(88);
const SIG_B = 'B'.repeat(88);

let dir: string;
let path: string;

beforeEach(() => {
  chmodFailure = null;
  writeFailure = null;
  chmodPaths = [];
  dir = mkdtempSync(join(tmpdir(), 'elisym-settle-write-'));
  path = join(dir, 'settlements.json');
});

afterEach(() => {
  chmodFailure = null;
  writeFailure = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('a write that fails leaves the settlement index untouched', () => {
  it('answers not-persisted and publishes nothing', () => {
    const store = createFileSettlementStore(path);
    expect(store.claim(SIG_B, 'job-b')).toBe('claimed');
    const before = readFileSync(path, 'utf-8');

    chmodFailure = new Error('EPERM: operation not permitted, chmod');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');

    // The permission step runs on the TEMPORARY, so the rename is the last
    // thing `write` does and cannot be reached once it has failed.
    // `every` is vacuously true on an empty array, so the count comes first.
    expect(chmodPaths.length).toBeGreaterThan(0);
    expect(chmodPaths.every((seen) => seen.includes('.tmp'))).toBe(true);
    expect(chmodPaths).not.toContain(path);
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(store.owner(SIG_A)).toBeUndefined();
    expect(createFileSettlementStore(path).owner(SIG_A)).toBeUndefined();

    // And once the disk recovers, the same job claims it for real.
    chmodFailure = null;
    expect(store.claim(SIG_A, 'job-a')).toBe('claimed');
    expect(createFileSettlementStore(path).owner(SIG_A)).toBe('job-a');
  });

  it('leaves no temporary behind, because a random name is never reused', () => {
    // With one fixed name the next write reused the leftover and the garbage
    // bounded itself. A random one does not, so every failure between the write
    // and the rename would strand a full copy of the index for good - and it
    // names which transaction paid for which job.
    const store = createFileSettlementStore(path);
    store.claim(SIG_B, 'job-b');

    chmodFailure = new Error('ENOSPC: no space left on device, chmod');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');

    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('takes a HALF-WRITTEN temporary with it, not only a complete one', () => {
    // The write is inside the cleanup, not only the rename: a disk that fills
    // up part way through leaves a fragment, and that fragment is a partial
    // copy of the index. Measured with its own lever, because the chmod one
    // fails after the file is already whole.
    const store = createFileSettlementStore(path);
    store.claim(SIG_B, 'job-b');

    writeFailure = new Error('ENOSPC: no space left on device, write');
    expect(store.claim(SIG_A, 'job-a')).toBe('not-persisted');

    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('throws out of prune, rather than reporting a sweep that did not land', () => {
    // The asymmetry the interface spells out: `claim` reports a refused write,
    // `prune` throws. A sweep that could not persist has released nothing, and
    // its caller is a schedule rather than a payment.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        settlements: {
          [SIG_A]: { job: 'job-a', at: Date.now() - MIN_SETTLEMENT_RETENTION_MS - 1 },
        },
      }),
      'utf-8',
    );
    const store = createFileSettlementStore(path);

    chmodFailure = new Error('EIO: i/o error, chmod');
    expect(() => store.prune(MIN_SETTLEMENT_RETENTION_MS)).toThrow(/EIO/);
    // Still there: a prune that threw released nothing.
    expect(createFileSettlementStore(path).owner(SIG_A)).toBe('job-a');
  });
});
