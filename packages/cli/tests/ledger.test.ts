import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobLedger } from '../src/ledger.js';

// JobLedger writes to ~/.elisym/agents/<name>/jobs.json
// We'll use a unique agent name per test to avoid conflicts
let testName: string;
let agentDir: string;

beforeEach(() => {
  testName = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  agentDir = join(homedir(), '.elisym', 'agents', testName);
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
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
    const ledger = new JobLedger(testName);
    expect(ledger.pendingJobs()).toEqual([]);
  });

  it('records paid job', () => {
    const ledger = new JobLedger(testName);
    ledger.recordPaid(makeEntry('job1'));

    expect(ledger.getStatus('job1')).toBe('paid');
    expect(ledger.pendingJobs()).toHaveLength(1);
  });

  it('transitions through states', () => {
    const ledger = new JobLedger(testName);
    ledger.recordPaid(makeEntry('job1'));
    expect(ledger.getStatus('job1')).toBe('paid');

    ledger.markExecuted('job1', 'result data');
    expect(ledger.getStatus('job1')).toBe('executed');

    ledger.markDelivered('job1');
    expect(ledger.getStatus('job1')).toBe('delivered');
    expect(ledger.pendingJobs()).toHaveLength(0);
  });

  it('marks failed', () => {
    const ledger = new JobLedger(testName);
    ledger.recordPaid(makeEntry('job1'));
    ledger.markFailed('job1');
    expect(ledger.getStatus('job1')).toBe('failed');
    expect(ledger.pendingJobs()).toHaveLength(0);
  });

  it('increments retry count', () => {
    const ledger = new JobLedger(testName);
    ledger.recordPaid(makeEntry('job1'));
    ledger.incrementRetry('job1');
    ledger.incrementRetry('job1');

    const pending = ledger.pendingJobs();
    expect(pending[0]!.retry_count).toBe(2);
  });

  it('persists across instances', () => {
    const ledger1 = new JobLedger(testName);
    ledger1.recordPaid(makeEntry('job1'));
    ledger1.markExecuted('job1', 'cached result');

    // New instance reads from disk
    const ledger2 = new JobLedger(testName);
    expect(ledger2.getStatus('job1')).toBe('executed');
    expect(ledger2.pendingJobs()).toHaveLength(1);
  });

  it('returns undefined for unknown jobs', () => {
    const ledger = new JobLedger(testName);
    expect(ledger.getStatus('nonexistent')).toBeUndefined();
  });

  it('pending includes paid and executed only', () => {
    const ledger = new JobLedger(testName);
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
    const ledger = new JobLedger(testName);
    ledger.recordPaid(makeEntry('job1'));

    ledger.updatePayment('job1', 9_700_000, '{"recipient":"addr"}');

    // Verify via new instance (persistence)
    const ledger2 = new JobLedger(testName);
    const pending = ledger2.pendingJobs();
    expect(pending[0]!.net_amount).toBe(9_700_000);
    expect(pending[0]!.payment_request).toBe('{"recipient":"addr"}');
  });

  it('stores payment_request without overwriting net_amount', () => {
    const ledger = new JobLedger(testName);
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
    const ledger = new JobLedger(testName);
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
    const ledger2 = new JobLedger(testName);
    ledger2.recordPaid(makeEntry('job2'));
    ledger2.markFailed('job2');
    expect(ledger2.getStatus('job2')).toBe('failed');

    // failed -> executed should be no-op
    ledger2.markExecuted('job2', 'result');
    expect(ledger2.getStatus('job2')).toBe('failed');
  });

  it('recordPaid does not overwrite existing entries', () => {
    const ledger = new JobLedger(testName);
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
    const ledger = new JobLedger(testName);
    ledger.recordPaid(makeEntry('job1'));

    // Replace flush to simulate disk full
    const originalFlush = ledger.flush.bind(ledger);
    let flushCalls = 0;
    ledger.flush = () => {
      flushCalls++;
      // Let the first flush (from markFailed's transition) throw
      throw new Error('ENOSPC: no space left on device');
    };

    // markFailed should not throw even when flush fails
    expect(() => ledger.markFailed('job1')).not.toThrow();
    expect(ledger.getStatus('job1')).toBe('failed'); // in-memory state still correct
  });

  it('gc removes old delivered/failed entries', () => {
    const ledger = new JobLedger(testName);
    const oldEntry = {
      ...makeEntry('old'),
      created_at: Math.floor(Date.now() / 1000) - 86400 * 30,
    };
    ledger.recordPaid(oldEntry);
    ledger.markExecuted('old', 'result');
    ledger.markDelivered('old');

    ledger.recordPaid(makeEntry('recent'));
    ledger.markExecuted('recent', 'result');
    ledger.markDelivered('recent');

    ledger.gc(86400 * 7); // 7 days

    expect(ledger.getStatus('old')).toBeUndefined();
    expect(ledger.getStatus('recent')).toBe('delivered');
  });
});
