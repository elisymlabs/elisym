/**
 * Idempotency store for the x402 bridge. elisym's delivery is
 * at-least-once: a crash between `skill.execute()` and the ledger flush
 * re-executes the job, and for a bridge that means paying the upstream
 * AGAIN. This store makes re-execution safe:
 *
 * - a *paid attempt* is recorded the moment a `PAYMENT-SIGNATURE` request
 *   leaves the process (see the instrumented fetch in the driver), capping
 *   money spent per job. An attempt whose payment the upstream definitively
 *   refuses with a fresh 402 can be refunded (no settle happened on an
 *   honest upstream), but the parallel *signatures* counter is monotonic -
 *   it caps how many signed payments can EVER leave for one job, because a
 *   malicious upstream can settle a payment and still respond 402;
 * - a completed *result* is recorded after the upstream responds, so
 *   recovery delivers the bought result instead of buying it twice. Binary
 *   results live as files in `.x402-results/<jobId>` written BEFORE the
 *   JSON record flush; a record whose file is missing counts as
 *   attempt-without-result.
 *
 * All read-modify-write cycles are serialized through one in-process async
 * queue: up to `maxConcurrentJobs` jobs share this single JSON file, and a
 * lost update would widen the double-payment window beyond the documented
 * crash-only case. Files are owned by this store's TTL sweep - result file
 * paths handed out for delivery must NOT be cleaned up by callers.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { X402_CACHE_TTL_MS } from './constants.js';

export const X402_JOBS_FILE = '.x402-jobs.json';
export const X402_RESULTS_DIR = '.x402-results';

type StoredResult = { kind: 'text'; data: string } | { kind: 'file'; mime: string };

interface X402JobRecord {
  attempts: number;
  /**
   * Monotonic count of signed payments ever sent for this job - never
   * refunded. Absent in records written before the counter existed; treated
   * as equal to `attempts` (those attempts were never refunded).
   */
  signatures?: number;
  result?: StoredResult;
  created_at: number;
  updated_at: number;
}

type X402JobsFile = Record<string, X402JobRecord>;

export interface X402CachedResult {
  data: string;
  outputMime?: string;
  filePath?: string;
}

export interface X402ClaimResult {
  granted: boolean;
  attempts: number;
  signatures: number;
  /** Which cap refused the claim; absent when granted. */
  refusedBy?: 'attempts' | 'signatures';
}

/** Keep result filenames safe regardless of what a jobId turns out to be. */
function sanitizeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export class X402JobStore {
  private readonly jobsPath: string;
  private readonly resultsDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(agentDir: string) {
    this.jobsPath = join(agentDir, X402_JOBS_FILE);
    this.resultsDir = join(agentDir, X402_RESULTS_DIR);
  }

  /** Serialize read-modify-write cycles; a failed task must not wedge the queue. */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(task, task);
    this.queue = scheduled.then(
      function ignoreResult() {},
      function ignoreError() {},
    );
    return scheduled;
  }

  private async load(): Promise<X402JobsFile> {
    let raw: string;
    try {
      raw = await readFile(this.jobsPath, 'utf-8');
    } catch (error) {
      // A missing file is a legitimate cold start -> empty ledger. Every
      // OTHER error (EACCES, EIO, a hand-edited file) must fail CLOSED: the
      // store gates re-payment, so silently treating a read error as "no
      // records" would reset the paid-attempt counter and drop cached
      // results, causing the bridge to pay the upstream again.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    // Must be a plain object: an array is `typeof 'object'` too, but a store
    // that decoded to an array is corrupt, not an empty ledger - fail closed
    // rather than treat it as "no records" and reset the paid-attempt budget.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`x402 store ${this.jobsPath} is not a JSON object`);
    }
    return parsed as X402JobsFile;
  }

  private async save(file: X402JobsFile): Promise<void> {
    const tempPath = `${this.jobsPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(file, null, 2), 'utf-8');
    await rename(tempPath, this.jobsPath);
  }

  resultFilePath(jobId: string): string {
    return join(this.resultsDir, sanitizeJobId(jobId));
  }

  /**
   * Atomically claim one paid attempt: increment iff still under BOTH caps
   * (durable attempts and the monotonic signature count), and FLUSH before
   * returning. The whole check-and-increment runs inside the serialization
   * queue so concurrent `execute()` flows for the same jobId (dedup failure,
   * crash-recovery racing the original) can never each read a stale count
   * and all pass the budget gate - the money bound holds. The flush ordering
   * errs on "an attempt happened", since the caller sends the payment
   * immediately after a grant.
   */
  async claimPaidAttempt(
    jobId: string,
    maxAttempts: number,
    maxSignatures: number,
  ): Promise<X402ClaimResult> {
    return this.runExclusive(async () => {
      const file = await this.load();
      const now = Date.now();
      const record = file[jobId] ?? { attempts: 0, created_at: now, updated_at: now };
      const signatures = record.signatures ?? record.attempts;
      // Persist nothing on refusal; the counts are already at the ceiling.
      if (signatures >= maxSignatures) {
        return { granted: false, attempts: record.attempts, signatures, refusedBy: 'signatures' };
      }
      if (record.attempts >= maxAttempts) {
        return { granted: false, attempts: record.attempts, signatures, refusedBy: 'attempts' };
      }
      record.attempts += 1;
      record.signatures = signatures + 1;
      record.updated_at = now;
      file[jobId] = record;
      await this.save(file);
      return { granted: true, attempts: record.attempts, signatures: record.signatures };
    });
  }

  /**
   * Return one durable attempt slot after the upstream DEFINITIVELY refused
   * the signed payment with a fresh 402 (an honest upstream did not settle,
   * so no money moved). The monotonic `signatures` counter is intentionally
   * NOT decremented: it is the adversarial bound against an upstream that
   * settles the payment and lies with a 402 (see `claimPaidAttempt`).
   */
  async refundPaidAttempt(jobId: string): Promise<void> {
    await this.runExclusive(async () => {
      const file = await this.load();
      const record = file[jobId];
      if (record === undefined || record.attempts === 0) {
        return;
      }
      const signatures = record.signatures ?? record.attempts;
      record.attempts -= 1;
      record.signatures = signatures;
      record.updated_at = Date.now();
      await this.save(file);
    });
  }

  /** Serialized point-in-time attempt count (test/inspection helper). */
  async paidAttempts(jobId: string): Promise<number> {
    return this.runExclusive(async () => {
      const file = await this.load();
      return file[jobId]?.attempts ?? 0;
    });
  }

  /** Serialized point-in-time signed-payment count (test/inspection helper). */
  async paymentSignatures(jobId: string): Promise<number> {
    return this.runExclusive(async () => {
      const file = await this.load();
      const record = file[jobId];
      return record === undefined ? 0 : (record.signatures ?? record.attempts);
    });
  }

  async saveTextResult(jobId: string, data: string): Promise<void> {
    await this.runExclusive(async () => {
      const file = await this.load();
      const now = Date.now();
      const record = file[jobId] ?? { attempts: 0, created_at: now, updated_at: now };
      record.result = { kind: 'text', data };
      record.updated_at = now;
      file[jobId] = record;
      await this.save(file);
    });
  }

  /** Binary result: bytes hit disk BEFORE the record flush (crash-safe ordering). */
  async saveFileResult(jobId: string, mime: string, bytes: Uint8Array): Promise<string> {
    const filePath = this.resultFilePath(jobId);
    await mkdir(this.resultsDir, { recursive: true });
    await writeFile(filePath, bytes);
    await this.runExclusive(async () => {
      const file = await this.load();
      const now = Date.now();
      const record = file[jobId] ?? { attempts: 0, created_at: now, updated_at: now };
      record.result = { kind: 'file', mime };
      record.updated_at = now;
      file[jobId] = record;
      await this.save(file);
    });
    return filePath;
  }

  /**
   * Completed result for this job, or null. A file record whose file went
   * missing degrades to attempt-without-result (the budget still applies).
   */
  async getResult(jobId: string): Promise<X402CachedResult | null> {
    const file = await this.load();
    const result = file[jobId]?.result;
    if (result === undefined) {
      return null;
    }
    if (result.kind === 'text') {
      return { data: result.data };
    }
    const filePath = this.resultFilePath(jobId);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return null;
      }
    } catch {
      return null;
    }
    return { data: '', outputMime: result.mime, filePath };
  }

  /** Drop records (and their result files) older than the cache TTL. */
  async sweepExpired(now = Date.now()): Promise<void> {
    await this.runExclusive(async () => {
      const file = await this.load();
      let changed = false;
      for (const [jobId, record] of Object.entries(file)) {
        if (now - record.updated_at <= X402_CACHE_TTL_MS) {
          continue;
        }
        delete file[jobId];
        changed = true;
        await rm(this.resultFilePath(jobId), { force: true }).catch(() => {});
      }
      if (changed) {
        await this.save(file);
      }
    });
  }
}
