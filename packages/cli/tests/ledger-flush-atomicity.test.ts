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
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('a fragment a crash left beside an index', () => {
  it.each([
    ['the job ledger', '.jobs.json', (path: string) => new JobLedger(path)],
    ['the nonce store', '.delegation-nonces.json', (path: string) => new UsedNonceStore(path)],
  ])('is swept when %s is next opened', (_label, filename, open) => {
    // The cleanup in `flush` only runs when the write THROWS. A process killed
    // outright leaves the fragment, the suffix is random so nothing reuses it,
    // and nothing else in the agent looks for one - it would sit there in the
    // clear for good. For the ledger that is a full copy of every job's input,
    // result and settlement signature.
    const path = join(tmpDir, filename);
    // A real index beside it, backdated too: the sweep must take the fragment
    // and leave this. Narrow the prefix to the bare basename - the obvious way
    // to write it - and the index itself matches, so a store nobody wrote to
    // for an hour is deleted along with every settlement it records.
    writeFileSync(path, '{}', 'utf-8');
    const stranded = `${path}.tmp.deadbeefcafe`;
    writeFileSync(stranded, '{"job-1":{"job_id":"job-1","input":"secret"}}', 'utf-8');
    // Older than the age guard, which is what keeps a second process's LIVE
    // temporary out of the sweep's way.
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(stranded, stale / 1000, stale / 1000);
    utimesSync(path, stale / 1000, stale / 1000);

    open(path);

    expect(readdirSync(tmpDir).filter((name) => name.includes('.tmp'))).toEqual([]);
    // The real index is untouched: the sweep matches the temporary's prefix,
    // not the file it is a temporary OF. Without this, narrowing the prefix to
    // the bare basename eats `.jobs.json` itself whenever nothing has written
    // to it for an hour - and with it the whole settlement index.
    expect(readdirSync(tmpDir)).toContain(filename);
  });

  it.each([
    ['the job ledger', '.jobs.json', (path: string) => new JobLedger(path)],
    ['the nonce store', '.delegation-nonces.json', (path: string) => new UsedNonceStore(path)],
  ])('is swept for %s even when an OLDER build left the bare name', (_label, filename, open) => {
    // The upgrade case, and the one that turns a self-limiting leak into a
    // permanent one: before this branch the temporary had a single fixed name,
    // so a fragment was reused by the next flush and bounded itself. With a
    // random suffix nothing reuses it - so a sweep that matches only the new
    // shape leaves an older build's fragment beside the index for good.
    const path = join(tmpDir, filename);
    writeFileSync(path, '{}', 'utf-8');
    const legacy = `${path}.tmp`;
    writeFileSync(legacy, '{"job-1":{"job_id":"job-1","input":"secret"}}', 'utf-8');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    utimesSync(legacy, stale / 1000, stale / 1000);
    utimesSync(path, stale / 1000, stale / 1000);

    open(path);

    expect(readdirSync(tmpDir).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(readdirSync(tmpDir)).toContain(filename);
  });

  it("is left alone while it is still fresh enough to be somebody else's", () => {
    // Two agents on one directory is unsupported, but a sweep must not be the
    // thing that makes it worse: a temporary written a moment ago may belong to
    // a live writer between its write and its rename.
    const path = join(tmpDir, '.jobs.json');
    const fresh = `${path}.tmp.feedfacebeef`;
    writeFileSync(fresh, '{}', 'utf-8');

    new JobLedger(path);

    expect(readdirSync(tmpDir)).toContain('.jobs.json.tmp.feedfacebeef');
  });
});
