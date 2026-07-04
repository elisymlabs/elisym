import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { X402_CACHE_TTL_MS } from '../src/x402/constants.js';
import { X402JobStore, X402_JOBS_FILE } from '../src/x402/store.js';

describe('X402JobStore', () => {
  let dir: string;
  let store: X402JobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elisym-x402-store-'));
    store = new X402JobStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('claims paid attempts up to the max and flushes each one to disk', async () => {
    expect(await store.paidAttempts('job-1')).toBe(0);
    expect(await store.claimPaidAttempt('job-1', 2)).toEqual({ granted: true, attempts: 1 });
    expect(await store.claimPaidAttempt('job-1', 2)).toEqual({ granted: true, attempts: 2 });
    // Third claim is refused without incrementing (the atomic budget gate).
    expect(await store.claimPaidAttempt('job-1', 2)).toEqual({ granted: false, attempts: 2 });
    expect(await store.paidAttempts('job-1')).toBe(2);
    const onDisk = JSON.parse(await readFile(join(dir, X402_JOBS_FILE), 'utf-8'));
    expect(onDisk['job-1'].attempts).toBe(2);
  });

  it('serializes concurrent claims and never exceeds the max (no lost updates)', async () => {
    const claims = Array.from({ length: 10 }, () => store.claimPaidAttempt('job-race', 2));
    const results = await Promise.all(claims);
    expect(results.filter((claim) => claim.granted)).toHaveLength(2);
    expect(await store.paidAttempts('job-race')).toBe(2);
  });

  it('round-trips a text result', async () => {
    await store.saveTextResult('job-2', 'hello world');
    expect(await store.getResult('job-2')).toEqual({ data: 'hello world' });
  });

  it('round-trips a binary result as a file without cleanup obligations', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const filePath = await store.saveFileResult('job-3', 'image/png', bytes);
    const result = await store.getResult('job-3');
    expect(result?.outputMime).toBe('image/png');
    expect(result?.filePath).toBe(filePath);
    expect(result?.data).toBe('');
    const fileStat = await stat(filePath);
    expect(fileStat.size).toBe(4);
  });

  it('treats a file record whose file is missing as attempt-without-result', async () => {
    const filePath = await store.saveFileResult('job-4', 'image/png', new Uint8Array([9]));
    await rm(filePath);
    expect(await store.getResult('job-4')).toBeNull();
  });

  it('returns null for unknown jobs', async () => {
    expect(await store.getResult('nope')).toBeNull();
  });

  it('fails closed on a corrupt store (does not reset the ledger to empty)', async () => {
    await store.claimPaidAttempt('job-x', 2);
    await writeFile(join(dir, X402_JOBS_FILE), '{ this is not json');
    // A corrupt/unreadable store must surface, not silently reset the
    // paid-attempt counter (which would let re-payment past the budget).
    await expect(store.paidAttempts('job-x')).rejects.toThrow();
    await expect(store.claimPaidAttempt('job-x', 2)).rejects.toThrow();
  });

  it('rejects a JSON array as a corrupt store (not an empty ledger)', async () => {
    await writeFile(join(dir, X402_JOBS_FILE), '[1,2,3]');
    await expect(store.paidAttempts('job-y')).rejects.toThrow(/not a JSON object/);
  });

  it('treats a missing store file as a clean cold start', async () => {
    // ENOENT is the one error that legitimately means "no records yet".
    expect(await store.getResult('cold')).toBeNull();
    expect(await store.paidAttempts('cold')).toBe(0);
  });

  it('sweeps records and files past the TTL', async () => {
    await store.saveTextResult('old-job', 'stale');
    const filePath = await store.saveFileResult('old-file-job', 'image/png', new Uint8Array([1]));
    await store.sweepExpired(Date.now() + X402_CACHE_TTL_MS + 1000);
    expect(await store.getResult('old-job')).toBeNull();
    expect(await store.getResult('old-file-job')).toBeNull();
    await expect(stat(filePath)).rejects.toThrow();
  });

  it('sanitizes hostile job ids in result file paths', async () => {
    const filePath = await store.saveFileResult(
      '../../etc/passwd',
      'text/x-evil',
      new Uint8Array([1]),
    );
    expect(filePath.startsWith(join(dir, '.x402-results'))).toBe(true);
    expect(filePath.includes('..')).toBe(false);
  });
});
