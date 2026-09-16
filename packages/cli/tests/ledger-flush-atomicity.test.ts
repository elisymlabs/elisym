/**
 * `JobLedger.flush()` must be all-or-nothing.
 *
 * `claimPaymentSignature` rolls ITSELF back when a flush throws - it un-assigns
 * the entry field and the in-memory owner - on the understanding that a failed
 * flush left nothing on disk. That contract is what makes a refused claim safe
 * to retry, and what stops a sibling job from being permanently blocked by a
 * settlement nobody ended up owning. If any step of `flush()` can throw AFTER
 * the new content is live, the rollback becomes a lie in the one direction that
 * costs money: the claim stands on disk while the process believes it does not,
 * so a second job can claim the same on-chain transaction and flush it. One
 * transaction, two jobs - exactly what the claim exists to prevent.
 *
 * Lives in its own file because it mocks `node:fs`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Set to make `chmodSync` fail, as a full disk or a hostile mode change would. */
let chmodFailure: Error | null = null;
/** Every path `chmodSync` was asked to change, in order. */
let chmodPaths: string[] = [];

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
  };
});

const { JobLedger } = await import('../src/ledger.js');

let tmpDir: string;
let ledgerPath: string;

function makeEntry(jobId: string) {
  return {
    job_id: jobId,
    input: 'test input',
    input_type: 'text',
    tags: ['elisym', 'text-gen'],
    customer_id: 'customer',
    created_at: Math.floor(Date.now() / 1000),
  };
}

beforeEach(() => {
  chmodFailure = null;
  chmodPaths = [];
  tmpDir = mkdtempSync(join(tmpdir(), 'elisym-flush-test-'));
  ledgerPath = join(tmpDir, '.jobs.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('a flush that fails leaves the ledger file untouched', () => {
  it('does not publish a claim whose flush threw', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-a'));
    ledger.recordPaid(makeEntry('job-b'));
    const before = readFileSync(ledgerPath, 'utf-8');

    chmodFailure = new Error('EPERM: operation not permitted, chmod');
    expect(ledger.claimPaymentSignature('sigShared', 'job-a')).toBe('not-persisted');

    // Nothing reached disk...
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(before);
    expect(before).not.toContain('sigShared');
    // ...and nothing was kept in memory either, so the signature is still free
    // for whichever job can actually verify it.
    expect(ledger.paymentSignatureOwner('sigShared')).toBeUndefined();

    // The permission step runs on the TEMP file, so the rename is the last thing
    // `flush` does and cannot be reached once it has failed.
    expect(chmodPaths.every((path) => path.endsWith('.tmp'))).toBe(true);

    // A restart sees the same: no owner, no orphaned claim.
    const reloaded = new JobLedger(ledgerPath);
    expect(reloaded.paymentSignatureOwner('sigShared')).toBeUndefined();
    expect(reloaded.getStatus('job-a')).toBe('paid');

    // And once the disk recovers, the same job claims it for real.
    chmodFailure = null;
    expect(ledger.claimPaymentSignature('sigShared', 'job-a')).toBe('claimed');
    expect(readFileSync(ledgerPath, 'utf-8')).toContain('sigShared');
  });

  it('a sibling job cannot inherit a claim that never landed', () => {
    // The money consequence spelled out: the refused job's settlement must not
    // be half-written, or `job-b` verifying the same transaction would flush a
    // ledger in which BOTH jobs own it.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-a'));
    ledger.recordPaid(makeEntry('job-b'));

    chmodFailure = new Error('ENOSPC: no space left on device, chmod');
    expect(ledger.claimPaymentSignature('sigShared', 'job-a')).toBe('not-persisted');
    chmodFailure = null;

    expect(ledger.claimPaymentSignature('sigShared', 'job-b')).toBe('claimed');
    const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Record<
      string,
      { payment_signature?: string }
    >;
    const owners = Object.values(onDisk).filter((entry) => entry.payment_signature === 'sigShared');
    expect(owners).toHaveLength(1);
    expect(onDisk['job-a']?.payment_signature).toBeUndefined();
  });
});
