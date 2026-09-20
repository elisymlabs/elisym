import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LEDGER_RETENTION_MS, MAX_PAID_AGE_MS } from '../src/helpers.js';
import { JobLedger, UsedNonceStore } from '../src/ledger.js';

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'elisym-ledger-test-'));
  ledgerPath = join(tmpDir, '.jobs.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(jobId: string) {
  return {
    job_id: jobId,
    input: 'test input',
    input_type: 'text',
    tags: ['test'],
    customer_id: 'customer123',
    created_at: Math.floor(Date.now() / 1000),
  };
}

describe('JobLedger', () => {
  it('starts empty for new agent', () => {
    const ledger = new JobLedger(ledgerPath);
    expect(ledger.pendingJobs()).toEqual([]);
  });

  it('records paid job', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));

    expect(ledger.getStatus('job1')).toBe('paid');
    expect(ledger.pendingJobs()).toHaveLength(1);
  });

  it('transitions through states', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));
    expect(ledger.getStatus('job1')).toBe('paid');

    ledger.markExecuted('job1', 'result data');
    expect(ledger.getStatus('job1')).toBe('executed');

    ledger.markDelivered('job1');
    expect(ledger.getStatus('job1')).toBe('delivered');
    expect(ledger.pendingJobs()).toHaveLength(0);
  });

  it('marks failed', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));
    ledger.markFailed('job1');
    expect(ledger.getStatus('job1')).toBe('failed');
    expect(ledger.pendingJobs()).toHaveLength(0);
  });

  it('increments retry count', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));
    ledger.incrementRetry('job1');
    ledger.incrementRetry('job1');

    const pending = ledger.pendingJobs();
    expect(pending[0]!.retry_count).toBe(2);
  });

  it('persists across instances', () => {
    const ledger1 = new JobLedger(ledgerPath);
    ledger1.recordPaid(makeEntry('job1'));
    ledger1.markExecuted('job1', 'cached result');

    // New instance reads from disk
    const ledger2 = new JobLedger(ledgerPath);
    expect(ledger2.getStatus('job1')).toBe('executed');
    expect(ledger2.pendingJobs()).toHaveLength(1);
  });

  it('returns undefined for unknown jobs', () => {
    const ledger = new JobLedger(ledgerPath);
    expect(ledger.getStatus('nonexistent')).toBeUndefined();
  });

  it('pending includes paid and executed only', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('j1'));
    ledger.recordPaid(makeEntry('j2'));
    ledger.recordPaid(makeEntry('j3'));

    ledger.markExecuted('j2', 'result');
    // Must go through executed before delivered (state machine enforcement)
    ledger.markExecuted('j3', 'result');
    ledger.markDelivered('j3');

    const pending = ledger.pendingJobs();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.job_id).sort()).toEqual(['j1', 'j2']);
  });

  it('updates payment info', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));

    ledger.updatePayment('job1', 9_700_000, '{"recipient":"addr"}');

    // Verify via new instance (persistence)
    const ledger2 = new JobLedger(ledgerPath);
    const pending = ledger2.pendingJobs();
    expect(pending[0]!.net_amount).toBe(9_700_000);
    expect(pending[0]!.payment_request).toBe('{"recipient":"addr"}');
  });

  it('stores payment_request without overwriting net_amount', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));

    // Early store: only payment_request, net_amount stays undefined
    ledger.updatePayment('job1', undefined, '{"reference":"ref123"}');

    const pending = ledger.pendingJobs();
    const entry = pending.find((e) => e.job_id === 'job1');
    expect(entry?.payment_request).toBe('{"reference":"ref123"}');
    expect(entry?.net_amount).toBeUndefined();

    // Later update with confirmed amount
    ledger.updatePayment('job1', 9_700_000);

    const pending2 = ledger.pendingJobs();
    const entry2 = pending2.find((e) => e.job_id === 'job1');
    expect(entry2?.net_amount).toBe(9_700_000);
    expect(entry2?.payment_request).toBe('{"reference":"ref123"}');
  });

  it('rejects invalid state transitions', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));
    ledger.markDelivered('job1');
    // delivered -> delivered is invalid, should be no-op (stays paid)
    expect(ledger.getStatus('job1')).toBe('paid');

    // Now do valid transition
    ledger.markExecuted('job1', 'result');
    expect(ledger.getStatus('job1')).toBe('executed');

    // recordPaid is a no-op for existing entries (overwrite guard)
    ledger.recordPaid(makeEntry('job1'));
    expect(ledger.getStatus('job1')).toBe('executed');

    // Test that failed is terminal
    const otherPath = join(tmpDir, '.jobs-2.json');
    const ledger2 = new JobLedger(otherPath);
    ledger2.recordPaid(makeEntry('job2'));
    ledger2.markFailed('job2');
    expect(ledger2.getStatus('job2')).toBe('failed');

    // failed -> executed should be no-op
    ledger2.markExecuted('job2', 'result');
    expect(ledger2.getStatus('job2')).toBe('failed');
  });

  it('recordPaid does not overwrite existing entries', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));
    ledger.markExecuted('job1', 'result');
    expect(ledger.getStatus('job1')).toBe('executed');

    // Second recordPaid should be a no-op
    ledger.recordPaid(makeEntry('job1'));
    expect(ledger.getStatus('job1')).toBe('executed');

    // Verify result is preserved
    const pending = ledger.pendingJobs();
    const entry = pending.find((e) => e.job_id === 'job1');
    expect(entry?.result).toBe('result');
  });

  it('markFailed does not throw on flush error', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job1'));

    // Replace flush to simulate disk full
    ledger.flush = () => {
      throw new Error('ENOSPC: no space left on device');
    };

    // markFailed should not throw even when flush fails
    expect(() => ledger.markFailed('job1')).not.toThrow();
    expect(ledger.getStatus('job1')).toBe('failed'); // in-memory state still correct
  });

  it('pruneOldEntries drops only terminal entries past retention', () => {
    const ledger = new JobLedger(ledgerPath);
    const nowSecs = Math.floor(Date.now() / 1000);

    // 31 days old, delivered - past retention, should drop.
    ledger.recordPaid({ ...makeEntry('old-delivered'), created_at: nowSecs - 86400 * 31 });
    ledger.markExecuted('old-delivered', 'result');
    ledger.markDelivered('old-delivered');

    // 31 days old, failed - past retention, should drop.
    ledger.recordPaid({ ...makeEntry('old-failed'), created_at: nowSecs - 86400 * 31 });
    ledger.markFailed('old-failed');

    // 31 days old, still 'paid' - stuck non-terminal, must be retained.
    ledger.recordPaid({ ...makeEntry('old-stuck'), created_at: nowSecs - 86400 * 31 });

    // Fresh delivered entry, must be retained.
    ledger.recordPaid({ ...makeEntry('fresh'), created_at: nowSecs });
    ledger.markExecuted('fresh', 'result');
    ledger.markDelivered('fresh');

    const deleted = ledger.pruneOldEntries(30 * 24 * 60 * 60 * 1000);
    expect(deleted).toBe(2);
    expect(ledger.getStatus('old-delivered')).toBeUndefined();
    expect(ledger.getStatus('old-failed')).toBeUndefined();
    expect(ledger.getStatus('old-stuck')).toBe('paid');
    expect(ledger.getStatus('fresh')).toBe('delivered');
  });

  it('pruneOldEntries retains an entry exactly at the retention boundary', () => {
    // Freeze the clock so `boundary` (computed here) and `cutoff` (computed
    // inside pruneOldEntries) reference the same whole second. Without this,
    // the test is flaky when a second tick falls between the two Date.now()
    // reads and boundary-keep slides across the cutoff.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));

      const ledger = new JobLedger(ledgerPath);
      const retentionSecs = 30 * 24 * 60 * 60;
      const boundary = Math.floor(Date.now() / 1000) - retentionSecs;

      // created_at exactly at cutoff - the condition is `< cutoff`, so boundary is kept.
      ledger.recordPaid({ ...makeEntry('boundary-keep'), created_at: boundary });
      ledger.markExecuted('boundary-keep', 'r');
      ledger.markDelivered('boundary-keep');

      // one second older - strictly before cutoff, should drop.
      ledger.recordPaid({ ...makeEntry('boundary-drop'), created_at: boundary - 1 });
      ledger.markExecuted('boundary-drop', 'r');
      ledger.markDelivered('boundary-drop');

      const deleted = ledger.pruneOldEntries(retentionSecs * 1000);
      expect(deleted).toBe(1);
      expect(ledger.getStatus('boundary-keep')).toBe('delivered');
      expect(ledger.getStatus('boundary-drop')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('delegated payment ledger fields', () => {
  it('persists discriminator, delivered_content, and the pull idempotency pair', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('delegated-1'));
    ledger.markDelegated('delegated-1');
    ledger.recordDeliveredContent('delegated-1', 'the result');
    ledger.recordPullSignature('delegated-1', 'sig-1', 424_242, 50_000);

    const reloaded = new JobLedger(ledgerPath);
    const entry = reloaded.allEntries().find((candidate) => candidate.job_id === 'delegated-1');
    expect(entry?.status).toBe('paid');
    expect(entry?.delegated).toBe(true);
    expect(entry?.delivered_content).toBe('the result');
    expect(entry?.pull_signature).toBe('sig-1');
    expect(entry?.pull_last_valid_block_height).toBe(424_242);
    expect(entry?.net_amount).toBe(50_000);
  });

  it('markDelivered/markFailed clear delivered_content but keep the pull signature', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('delegated-2'));
    ledger.recordDeliveredContent('delegated-2', 'the result');
    ledger.recordPullSignature('delegated-2', 'sig-2', 1, 1);
    ledger.markExecuted('delegated-2', 'the result');
    ledger.markDelivered('delegated-2');
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'delegated-2');
    expect(entry?.delivered_content).toBeUndefined();
    expect(entry?.pull_signature).toBe('sig-2');
  });
});

describe('UsedNonceStore', () => {
  it('marks, persists, and reloads burned nonces', () => {
    const storePath = join(tmpDir, '.delegation-nonces.json');
    const store = new UsedNonceStore(storePath);
    const retainUntil = Math.floor(Date.now() / 1000) + 600;
    expect(store.has('owner:nonce1')).toBe(false);
    store.markUsed('owner:nonce1', retainUntil);
    expect(store.has('owner:nonce1')).toBe(true);

    const reloaded = new UsedNonceStore(storePath);
    expect(reloaded.has('owner:nonce1')).toBe(true);
  });

  it('prunes entries past retain-until, keeps live ones', () => {
    const store = new UsedNonceStore(join(tmpDir, '.nonces-prune.json'));
    const now = Math.floor(Date.now() / 1000);
    store.markUsed('owner:old', now - 10);
    store.markUsed('owner:live', now + 600);
    expect(store.prune(now)).toBe(1);
    expect(store.has('owner:old')).toBe(false);
    expect(store.has('owner:live')).toBe(true);
  });

  it('evicts the OLDEST entry on overflow instead of rejecting', () => {
    const store = new UsedNonceStore(join(tmpDir, '.nonces-cap.json'), 3);
    const retainUntil = Math.floor(Date.now() / 1000) + 600;
    store.markUsed('owner:a', retainUntil);
    store.markUsed('owner:b', retainUntil);
    store.markUsed('owner:c', retainUntil);
    store.markUsed('owner:d', retainUntil);
    expect(store.size()).toBe(3);
    expect(store.has('owner:a')).toBe(false); // oldest evicted
    expect(store.has('owner:d')).toBe(true); // newest always accepted
  });

  it('survives a corrupt store file (backs it up, starts empty)', () => {
    const storePath = join(tmpDir, '.nonces-corrupt.json');
    writeFileSync(storePath, 'not json');
    const store = new UsedNonceStore(storePath);
    expect(store.size()).toBe(0);
    store.markUsed('owner:x', Math.floor(Date.now() / 1000) + 600);
    expect(new UsedNonceStore(storePath).has('owner:x')).toBe(true);
  });
});

/**
 * "One transaction settles one job" lives in the ledger itself - the SDK
 * verifier is stateless by contract (see `PaymentStrategy.verifyPayment`), so
 * this index is the only thing that stops one transfer from paying N jobs.
 */
describe('settlement-signature index', () => {
  it('claims an unclaimed settlement signature for a job', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    expect(ledger.paymentSignatureOwner('sigA')).toBeUndefined();
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
    expect(ledger.paymentSignatureOwner('sigA')).toBe('job-1');
  });

  it('re-claim by the SAME job succeeds (re-confirmation and crash recovery)', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
  });

  it('a SECOND, DIFFERENT claim by the same job releases the first mark', () => {
    // The entry carries exactly ONE `payment_signature`, and the index must not
    // outlive the entry field that justifies it: `pruneOldEntries` releases
    // marks by walking the entries, so a mark with no entry behind it survives
    // every prune and blocks that transaction for the life of the process.
    // Reachable for real: a job whose claimed settlement stops verifying falls
    // back to the reference scan, which may find a different transaction.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
    expect(ledger.claimPaymentSignature('sigB', 'job-1')).toBe('claimed');

    expect(ledger.paymentSignatureOwner('sigB')).toBe('job-1');
    expect(ledger.paymentSignatureOwner('sigA')).toBeUndefined();
    // Only ONE signature is persisted, so the index and the entries agree - the
    // invariant a reload would otherwise silently repair and a prune would not.
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'job-1');
    expect(entry?.payment_signature).toBe('sigB');
    const reloaded = new JobLedger(ledgerPath);
    expect(reloaded.paymentSignatureOwner('sigA')).toBeUndefined();
    expect(reloaded.paymentSignatureOwner('sigB')).toBe('job-1');
  });

  it('a REFUSED second claim leaves the first mark exactly where it was', () => {
    // Fail closed on both sides: a disk write that fails must not quietly hand
    // the job's earlier settlement to somebody else.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    ledger.recordPaid(makeEntry('job-2'));
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');

    const flushSpy = vi.spyOn(ledger, 'flush').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(ledger.claimPaymentSignature('sigB', 'job-1')).toBe('not-persisted');
    flushSpy.mockRestore();

    expect(ledger.paymentSignatureOwner('sigA')).toBe('job-1');
    expect(ledger.paymentSignatureOwner('sigB')).toBeUndefined();
    expect(ledger.claimPaymentSignature('sigA', 'job-2')).toBe('consumed-by-other');
  });

  it('refuses to key a claim on an unusable signature, whoever asks', () => {
    // The invariant is the method's own, not a favour from the two callers that
    // check it first today. A claim keyed on an empty string owns nothing -
    // `indexPaymentSignatures` skips it on the next load - so the transaction
    // it stood for is free for the next job while this one believes it
    // settled. Measured here because the runtime's own guard sits in front of
    // this one: with only that row, removing EITHER gate alone left the package
    // green, and neither was pinned on its own.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));

    expect(ledger.claimPaymentSignature('', 'job-1')).toBe('unknown-job');
    expect(ledger.paymentSignatureOwner('')).toBeUndefined();
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'job-1');
    expect(entry?.payment_signature).toBeUndefined();
  });

  it('refuses a signature already consumed by a DIFFERENT job', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    ledger.recordPaid(makeEntry('job-2'));
    expect(ledger.claimPaymentSignature('shared-sig', 'job-1')).toBe('claimed');
    expect(ledger.claimPaymentSignature('shared-sig', 'job-2')).toBe('consumed-by-other');
    // The original owner is untouched by the refused claim, and the loser never
    // records a signature it does not own.
    expect(ledger.paymentSignatureOwner('shared-sig')).toBe('job-1');
    const loser = ledger.allEntries().find((entry) => entry.job_id === 'job-2');
    expect(loser?.payment_signature).toBeUndefined();
  });

  it('persists the claim and rebuilds the index on reload', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    ledger.recordPaid(makeEntry('job-2'));
    ledger.claimPaymentSignature('sigA', 'job-1');

    const reloaded = new JobLedger(ledgerPath);
    expect(reloaded.paymentSignatureOwner('sigA')).toBe('job-1');
    expect(reloaded.claimPaymentSignature('sigA', 'job-2')).toBe('consumed-by-other');
    expect(reloaded.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
  });

  it('keeps the claim through markDelivered / markFailed', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('paid-1'));
    ledger.claimPaymentSignature('settlement-sig-1', 'paid-1');
    ledger.markExecuted('paid-1', 'result');
    ledger.markDelivered('paid-1');

    const reloaded = new JobLedger(ledgerPath);
    const entry = reloaded.allEntries().find((candidate) => candidate.job_id === 'paid-1');
    expect(entry?.payment_signature).toBe('settlement-sig-1');
    // A terminal job still owns its settlement until the entry is pruned.
    reloaded.recordPaid(makeEntry('paid-2'));
    expect(reloaded.claimPaymentSignature('settlement-sig-1', 'paid-2')).toBe('consumed-by-other');
  });

  it('shouts when the ledger already holds one signature on two jobs', () => {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        'job-a': {
          ...makeEntry('job-a'),
          status: 'delivered',
          retry_count: 0,
          payment_signature: 'double-settled-sig',
          created_at: now,
        },
        'job-b': {
          ...makeEntry('job-b'),
          status: 'delivered',
          retry_count: 0,
          payment_signature: 'double-settled-sig',
          created_at: now,
        },
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new JobLedger(ledgerPath);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    warn.mockRestore();

    expect(warned).toContain('DOUBLE SETTLE');
    expect(warned).toContain('job-a');
    expect(warned).toContain('job-b');
    // First writer keeps ownership; the duplicate does not silently take it.
    expect(ledger.paymentSignatureOwner('double-settled-sig')).toBe('job-a');
  });

  /**
   * A ledger that ALREADY double-settles: two entries carry one signature, which
   * `indexPaymentSignatures` warns about and resolves by keeping the first as
   * owner. The loser's `payment_signature` field then names a mark it does not
   * hold - the one state in which the release/rollback around a second claim can
   * touch somebody else's settlement.
   */
  function loadDoubleSettledLedger(sharedSignature: string, extraJobIds: string[] = []): JobLedger {
    const now = Math.floor(Date.now() / 1000);
    const settled = (jobId: string) => ({
      ...makeEntry(jobId),
      status: 'paid',
      retry_count: 0,
      payment_signature: sharedSignature,
      created_at: now,
    });
    const extras = Object.fromEntries(
      extraJobIds.map((jobId) => [jobId, { ...makeEntry(jobId), status: 'paid', retry_count: 0 }]),
    );
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        'job-owner': settled('job-owner'),
        'job-rival': settled('job-rival'),
        ...extras,
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new JobLedger(ledgerPath);
    warn.mockRestore();
    return ledger;
  }

  it('a second claim never releases a mark this job does not own', () => {
    // On a double-settled ledger `job-rival`'s entry names `sigShared`, but the
    // index gave that mark to `job-owner`. Releasing it on the strength of the
    // entry field alone would free a settlement the rightful owner still holds -
    // and hand it to a third job, turning one bad ledger into a second double
    // settle the index itself created.
    const ledger = loadDoubleSettledLedger('sigShared', ['job-third']);
    expect(ledger.paymentSignatureOwner('sigShared')).toBe('job-owner');

    expect(ledger.claimPaymentSignature('sigNew', 'job-rival')).toBe('claimed');

    expect(ledger.paymentSignatureOwner('sigShared')).toBe('job-owner');
    expect(ledger.claimPaymentSignature('sigShared', 'job-third')).toBe('consumed-by-other');
  });

  it('a REFUSED second claim never re-assigns a mark to the job that failed it', () => {
    // The mirror image, on the rollback path. `job-rival` fails to persist a new
    // claim; restoring `sigShared` to *it* would overwrite `job-owner`'s mark and
    // leave the rightful owner refused on its own settlement until a restart
    // rebuilt the index.
    const ledger = loadDoubleSettledLedger('sigShared');
    const flushSpy = vi.spyOn(ledger, 'flush').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(ledger.claimPaymentSignature('sigNew', 'job-rival')).toBe('not-persisted');
    flushSpy.mockRestore();

    expect(ledger.paymentSignatureOwner('sigShared')).toBe('job-owner');
    expect(ledger.claimPaymentSignature('sigShared', 'job-owner')).toBe('claimed');
  });

  it('fails CLOSED when the claim cannot be persisted, and self-heals on retry', () => {
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    const flushSpy = vi.spyOn(ledger, 'flush').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    // Refused: a mark we cannot persist would be forgotten by a restart.
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('not-persisted');
    // The same job retrying once the disk is healthy succeeds.
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
    flushSpy.mockRestore();
    expect(new JobLedger(ledgerPath).paymentSignatureOwner('sigA')).toBe('job-1');
  });

  it('binds NOTHING - on disk or in memory - when the claim cannot be persisted', () => {
    // A claim whose flush failed rolls back both sides. Keeping the in-memory
    // mark would be best-effort at best (a restart discards it) and would block,
    // for the life of this process, a sibling that can verify the very same
    // transaction and is equally entitled to it.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    ledger.recordPaid(makeEntry('job-2'));
    const flushSpy = vi.spyOn(ledger, 'flush').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('not-persisted');
    flushSpy.mockRestore();

    expect(ledger.paymentSignatureOwner('sigA')).toBeUndefined();
    expect(ledger.claimPaymentSignature('sigA', 'job-2')).toBe('claimed');
  });

  it('a failed re-claim leaves the EXISTING owner in place', () => {
    // Rollback restores what was there, it does not blank the index: a job
    // re-claiming its own settlement over a full disk must not hand the
    // transaction to the next caller.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    ledger.recordPaid(makeEntry('job-2'));
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');

    const flushSpy = vi.spyOn(ledger, 'flush').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('not-persisted');
    flushSpy.mockRestore();

    expect(ledger.paymentSignatureOwner('sigA')).toBe('job-1');
    expect(ledger.claimPaymentSignature('sigA', 'job-2')).toBe('consumed-by-other');
  });

  it('a refused claim never becomes durable through a LATER write', () => {
    // The entry field must only be assigned once the flush that persists it
    // succeeded: leaving it assigned lets the next unrelated flush (a retry
    // bump, a status change) quietly record a settlement this job was refused.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    const flushSpy = vi.spyOn(ledger, 'flush').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('not-persisted');
    flushSpy.mockRestore();

    const inMemory = ledger.allEntries().find((entry) => entry.job_id === 'job-1');
    expect(inMemory?.payment_signature).toBeUndefined();

    // An ordinary, unrelated write now flushes the whole ledger.
    ledger.incrementRetry('job-1');
    const reloaded = new JobLedger(ledgerPath);
    expect(
      reloaded.allEntries().find((entry) => entry.job_id === 'job-1')?.payment_signature,
    ).toBeUndefined();
    expect(reloaded.paymentSignatureOwner('sigA')).toBeUndefined();
  });

  it('distinguishes an unwritable ledger from a job that was never recorded', () => {
    const ledger = new JobLedger(ledgerPath);
    expect(ledger.claimPaymentSignature('sigA', 'never-recorded')).toBe('unknown-job');
  });

  it('releases the signature when the entry is pruned', () => {
    const ledger = new JobLedger(ledgerPath);
    const old = { ...makeEntry('job-old'), created_at: Math.floor(Date.now() / 1000) - 10_000 };
    ledger.recordPaid(old);
    ledger.claimPaymentSignature('sigA', 'job-old');
    ledger.markFailed('job-old');

    expect(ledger.pruneOldEntries(1000)).toBe(1);
    expect(ledger.paymentSignatureOwner('sigA')).toBeUndefined();
  });

  it("pruning a NON-owner entry does not release the surviving owner's signature", () => {
    // After a double settle the same signature sits on two entries. Pruning the
    // one that lost the index must not hand the winner's settlement to a third
    // job while the winner is still on disk.
    const old = Math.floor(Date.now() / 1000) - 10_000;
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        'job-owner': {
          ...makeEntry('job-owner'),
          status: 'delivered',
          retry_count: 0,
          payment_signature: 'shared-sig',
          created_at: Math.floor(Date.now() / 1000),
        },
        'job-shadow': {
          ...makeEntry('job-shadow'),
          status: 'failed',
          retry_count: 0,
          payment_signature: 'shared-sig',
          created_at: old,
        },
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new JobLedger(ledgerPath);
    warn.mockRestore();
    expect(ledger.paymentSignatureOwner('shared-sig')).toBe('job-owner');

    // Only the shadow entry is old enough to prune.
    expect(ledger.pruneOldEntries(1000)).toBe(1);
    expect(ledger.paymentSignatureOwner('shared-sig')).toBe('job-owner');

    ledger.recordPaid(makeEntry('job-third'));
    expect(ledger.claimPaymentSignature('shared-sig', 'job-third')).toBe('consumed-by-other');
  });

  /**
   * RETENTION INVARIANT, behaviourally: a rival can only present the winner's
   * transaction while it is itself alive, i.e. within `MAX_PAID_AGE_MS` of its
   * own creation, and it may have been created long after the winner - so the
   * winner's record must survive twice that age.
   */
  it('keeps a settlement record for twice the maximum paid-job age', () => {
    const ledger = new JobLedger(ledgerPath);
    const nowSecs = Math.floor(Date.now() / 1000);
    const maxPaidAgeSecs = Math.floor(MAX_PAID_AGE_MS / 1000);

    // Just inside 2x the maximum life of a competing job: must survive.
    ledger.recordPaid({ ...makeEntry('within'), created_at: nowSecs - 2 * maxPaidAgeSecs + 60 });
    ledger.claimPaymentSignature('sig-within', 'within');
    ledger.markFailed('within');

    // Past the whole retention window: expected to go.
    ledger.recordPaid({
      ...makeEntry('beyond'),
      created_at: nowSecs - Math.floor(LEDGER_RETENTION_MS / 1000) - 60,
    });
    ledger.claimPaymentSignature('sig-beyond', 'beyond');
    ledger.markFailed('beyond');

    expect(ledger.pruneOldEntries(LEDGER_RETENTION_MS)).toBe(1);
    expect(ledger.paymentSignatureOwner('sig-within')).toBe('within');
    expect(ledger.paymentSignatureOwner('sig-beyond')).toBeUndefined();
  });

  it('reports a missing entry as unknown-job even when the signature is taken', () => {
    // Outcome ORDER: `unknown-job` is a provider wiring bug and
    // `consumed-by-other` a customer/attacker state. Reporting the second when
    // the truth is the first sends the operator to audit a payment dispute that
    // does not exist.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
    expect(ledger.claimPaymentSignature('sigA', 'never-recorded')).toBe('unknown-job');
    // ...and the refusal changed nothing.
    expect(ledger.paymentSignatureOwner('sigA')).toBe('job-1');
  });

  it('a delivered job KEEPS the settlement it actually persisted', () => {
    // The companion to the release above: only marks that never reached disk go.
    // A terminal job still owns the transaction it really consumed, until the
    // entry itself is pruned.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-1'));
    ledger.recordPaid(makeEntry('job-2'));
    expect(ledger.claimPaymentSignature('sigA', 'job-1')).toBe('claimed');
    ledger.markExecuted('job-1', 'result');
    ledger.markDelivered('job-1');

    expect(ledger.paymentSignatureOwner('sigA')).toBe('job-1');
    expect(ledger.claimPaymentSignature('sigA', 'job-2')).toBe('consumed-by-other');
  });

  it('a prune never releases a mark owned by a job that is still live', () => {
    // The sweep must only release the signatures of the entries it actually
    // deleted. A sweep that rebuilt or blanked the index would hand a live job's
    // settlement to the next caller on the next unrelated prune.
    const ledger = new JobLedger(ledgerPath);
    ledger.recordPaid(makeEntry('job-live'));
    ledger.recordPaid(makeEntry('job-rival'));
    ledger.recordPaid({
      ...makeEntry('job-ancient'),
      created_at: Math.floor(Date.now() / 1000) - 10_000,
    });
    ledger.claimPaymentSignature('sigAncient', 'job-ancient');
    ledger.markFailed('job-ancient');
    expect(ledger.claimPaymentSignature('sigLive', 'job-live')).toBe('claimed');

    // The old entry is pruned; `job-live` is still `paid` and retrying.
    expect(ledger.pruneOldEntries(1000)).toBe(1);
    expect(ledger.paymentSignatureOwner('sigAncient')).toBeUndefined();
    expect(ledger.paymentSignatureOwner('sigLive')).toBe('job-live');
    expect(ledger.claimPaymentSignature('sigLive', 'job-rival')).toBe('consumed-by-other');
  });

  it('keeps a mark whose signature is still on a SURVIVING entry, even when its owner is pruned', () => {
    // The other half of the double-settle prune rule. When the index OWNER is
    // the entry being pruned but a second entry still carries the signature on
    // disk, releasing the mark would hand a transaction the ledger still
    // records to a third job. The on-disk record wins.
    const old = Math.floor(Date.now() / 1000) - 10_000;
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        'job-owner': {
          ...makeEntry('job-owner'),
          status: 'delivered',
          retry_count: 0,
          payment_signature: 'shared-sig',
          created_at: old,
        },
        'job-shadow': {
          ...makeEntry('job-shadow'),
          status: 'delivered',
          retry_count: 0,
          payment_signature: 'shared-sig',
          created_at: Math.floor(Date.now() / 1000),
        },
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new JobLedger(ledgerPath);
    warn.mockRestore();
    expect(ledger.paymentSignatureOwner('shared-sig')).toBe('job-owner');

    // Only the owner entry is old enough to prune; the shadow still carries it.
    expect(ledger.pruneOldEntries(1000)).toBe(1);
    ledger.recordPaid(makeEntry('job-third'));
    expect(ledger.claimPaymentSignature('shared-sig', 'job-third')).toBe('consumed-by-other');
  });

  it('warns once per duplicated SIGNATURE, not once per entry', () => {
    // A corrupt ledger repeating one signature across thousands of entries once
    // produced ~30 000 identical warnings, burying every other startup line.
    const now = Math.floor(Date.now() / 1000);
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < 50; index++) {
      entries[`job-${index}`] = {
        ...makeEntry(`job-${index}`),
        status: 'delivered',
        retry_count: 0,
        payment_signature: 'one-repeated-sig',
        created_at: now,
      };
    }
    writeFileSync(ledgerPath, JSON.stringify(entries));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new JobLedger(ledgerPath);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();

    expect(lines.filter((line) => line.includes('DOUBLE SETTLE'))).toHaveLength(1);
    expect(ledger.paymentSignatureOwner('one-repeated-sig')).toBe('job-0');
  });

  it('caps the number of distinct double settles it lists, and says how many it hid', () => {
    const now = Math.floor(Date.now() / 1000);
    const entries: Record<string, unknown> = {};
    // 40 distinct signatures, each on two entries: 40 duplicates, cap is 20.
    for (let index = 0; index < 40; index++) {
      for (const suffix of ['a', 'b']) {
        entries[`job-${index}${suffix}`] = {
          ...makeEntry(`job-${index}${suffix}`),
          status: 'delivered',
          retry_count: 0,
          payment_signature: `sig-${index}`,
          created_at: now,
        };
      }
    }
    writeFileSync(ledgerPath, JSON.stringify(entries));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new JobLedger(ledgerPath);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();

    const named = lines.filter((line) => line.includes('is recorded'));
    expect(named.length).toBeLessThanOrEqual(20);
    expect(lines.some((line) => /\d+ further duplicated settlement signature/.test(line))).toBe(
      true,
    );
  });

  it('ignores a non-string payment_signature at load', () => {
    // A hand-edited or corrupt ledger can carry anything here. Indexing it would
    // key the map on a value no ordinary string claim can ever collide with,
    // which is worse than the entry simply owning nothing.
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        'job-corrupt': {
          ...makeEntry('job-corrupt'),
          status: 'paid',
          retry_count: 0,
          payment_signature: 12_345,
          created_at: now,
        },
        'job-empty': {
          ...makeEntry('job-empty'),
          status: 'paid',
          retry_count: 0,
          payment_signature: '',
          created_at: now,
        },
      }),
    );

    const ledger = new JobLedger(ledgerPath);
    expect(ledger.paymentSignatureOwner('12345')).toBeUndefined();
    expect(ledger.paymentSignatureOwner('')).toBeUndefined();
    // And a normal claim on the same job still works.
    expect(ledger.claimPaymentSignature('realSig', 'job-corrupt')).toBe('claimed');
  });

  it('builds the WHOLE index even when an entry is not an object at all', () => {
    // The one hostile shape that bypasses every guard downstream. Reading
    // `payment_signature` off `null` THROWS, and the index build used to sit
    // inside the load's own try/catch - so the throw was swallowed as "corrupt
    // ledger" AFTER the entries had all been loaded. The agent kept running with
    // an index built only as far as the bad value: every settlement recorded
    // after it read back as unclaimed, so a transaction this ledger had already
    // spent could settle a second job - the exact hole this whole rail exists to
    // close. Worse, the swallowed throw also renamed the live ledger away.
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        'job-before': {
          ...makeEntry('job-before'),
          status: 'paid',
          retry_count: 0,
          payment_signature: 'sigBefore',
          created_at: now,
        },
        'job-null': null,
        'job-text': 'not an entry at all',
        'job-list': [],
        'job-nameless': {
          ...makeEntry('job-nameless'),
          job_id: undefined,
          status: 'paid',
          retry_count: 0,
          payment_signature: 'sigNameless',
          created_at: now,
        },
        // The other half of "no job id", and it fails the opposite way: an empty
        // id indexes as owner `''`, so the job that really paid is REFUSED its
        // own transaction rather than a stranger being handed it.
        'job-blank': {
          ...makeEntry('job-blank'),
          job_id: '',
          status: 'paid',
          retry_count: 0,
          payment_signature: 'sigBlank',
          created_at: now,
        },
        'job-after': {
          ...makeEntry('job-after'),
          status: 'paid',
          retry_count: 0,
          payment_signature: 'sigAfter',
          created_at: now,
        },
      }),
    );

    const ledger = new JobLedger(ledgerPath);

    // Every settlement on BOTH sides of the unusable values is indexed...
    expect(ledger.paymentSignatureOwner('sigBefore')).toBe('job-before');
    expect(ledger.paymentSignatureOwner('sigAfter')).toBe('job-after');
    // ...so a rival job cannot spend either of them a second time.
    expect(ledger.claimPaymentSignature('sigAfter', 'job-before')).toBe('consumed-by-other');
    // An entry with no job id owns nothing - it cannot, ownership IS the id - so
    // it must not reach the pending set either. Left there it is handed to
    // recovery on every tick, which reads `job_id` off it and throws, for the
    // whole 24h an entry can live; and because pruning only touches terminal
    // entries, nothing ever clears it.
    expect(ledger.paymentSignatureOwner('sigNameless')).toBeUndefined();
    // An empty id must not squat the signature either: indexed, it would answer
    // `''`, and the job that really paid would be refused its own transaction as
    // `consumed-by-other` for as long as the file says so.
    expect(ledger.paymentSignatureOwner('sigBlank')).toBeUndefined();
    expect(ledger.pendingJobs().map((entry) => entry.job_id)).toEqual(['job-before', 'job-after']);
    // And the live ledger is still there: the file parsed, so nothing about it
    // is "corrupt" in the sense that justifies renaming a provider's history out
    // from under them.
    expect(existsSync(ledgerPath)).toBe(true);
    expect(readdirSync(tmpDir).filter((name) => name.includes('.corrupt.'))).toEqual([]);
  });
});
