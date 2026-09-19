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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Set to make `chmodSync` fail, as a full disk or a hostile mode change would. */
let chmodFailure: Error | null = null;
/**
 * Set to make the WRITE fail after it has put down part of the file, as ENOSPC
 * does. A separate lever from the chmod one: this is the only way to reach a
 * FRAGMENT, and the fragment is a partial copy of the ledger - customer inputs
 * in the clear - under a name nothing ever reuses or sweeps.
 */
let writeFailure: Error | null = null;
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
    writeFileSync: (path: string, data: string, options?: unknown) => {
      if (writeFailure) {
        actual.writeFileSync(
          path as string,
          data.slice(0, Math.floor(data.length / 2)),
          options as Parameters<typeof actual.writeFileSync>[2],
        );
        throw writeFailure;
      }
      return actual.writeFileSync(
        path as string,
        data,
        options as Parameters<typeof actual.writeFileSync>[2],
      );
    },
  };
});

const { JobLedger, UsedNonceStore } = await import('../src/ledger.js');

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
  writeFailure = null;
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
    // `flush` does and cannot be reached once it has failed. The temp name
    // carries a random suffix - a predictable one is a path somebody else can
    // put a FIFO on, and a synchronous write to one never returns - so this
    // asserts the SHAPE and, above all, that the live file was never chmod'd.
    expect(chmodPaths.every((path) => path.includes('.tmp.'))).toBe(true);
    expect(chmodPaths).not.toContain(ledgerPath);

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

describe('a flush that fails part way through the write', () => {
  it('leaves no fragment behind', () => {
    // The temporary carries a random suffix, so nothing reuses it and nothing
    // sweeps it: a write that stops half way would strand a partial copy of the
    // ledger for good. The cleanup has to take it, and only a lever on the
    // WRITE can prove that - the chmod lever fails once the file is whole.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-a'));

    writeFailure = new Error('ENOSPC: no space left on device, write');
    expect(() => ledger.recordPaid(makeEntry('job-b'))).toThrow(/ENOSPC/);
    writeFailure = null;

    expect(readdirSync(tmpDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('leaves no fragment behind from the NONCE store either', () => {
    // The same shape one file over, and the one member of this class that
    // nothing measured: removing its cleanup alone left the whole cli package
    // green. What a stranded fragment holds here is the burn set - the customer
    // owner addresses that delegated to this agent - under a random name no
    // sweep visits and no older agent's `.gitignore` line matches.
    const noncePath = join(tmpDir, '.delegation-nonces.json');
    const store = new UsedNonceStore(noncePath);
    store.markUsed('nonce-1', Math.floor(Date.now() / 1000) + 3600);

    // `markUsed` SWALLOWS a failed flush on purpose - the in-memory set still
    // enforces single use for this process - so the fragment, not an exception,
    // is the only observable thing a broken cleanup leaves behind.
    writeFailure = new Error('ENOSPC: no space left on device, write');
    store.markUsed('nonce-2', Math.floor(Date.now() / 1000) + 3600);
    writeFailure = null;

    expect(readdirSync(tmpDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
