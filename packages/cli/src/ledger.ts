/**
 * Job recovery ledger - persistent JSON storage for crash recovery.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// Ledger files hold customer-confidential job content (inputs, results). Lock
// the directory and files down to owner-only, matching the rest of the agent
// store, so other local users cannot read them.
const LEDGER_DIR_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;

export type LedgerStatus = 'paid' | 'executed' | 'delivered' | 'failed';

export interface LedgerEntry {
  job_id: string;
  status: LedgerStatus;
  input: string;
  input_type: string;
  tags: string[];
  customer_id: string;
  bid?: number;
  payment_request?: string;
  net_amount?: number;
  result?: string;
  raw_event_json?: string;
  /**
   * JSON-serialized `FileAttachment` for a file result. Persisted so crash
   * recovery can rebuild the descriptor and re-share the blob for a fresh ticket.
   * Unlike `result`, this is NOT nulled by `markDelivered`/`markFailed` - the
   * provider keeps seeding the result blob through the retention window, and
   * recovery needs the descriptor to re-deliver. (A file INPUT's descriptor is
   * recovered from the persisted decrypted `raw_event_json`, not stored here.)
   */
  result_attachment?: string;
  /**
   * Result descriptors for a MULTI-file job (each a serialized FileAttachment).
   * Supersedes `result_attachment`; recovery prefers this and falls back to the
   * single field for jobs recorded before multi-file support.
   */
  result_attachments?: string[];
  /**
   * Delegated-payment discriminator, flushed at the pre-check nonce mark.
   * WITHOUT it a pre-pull delegated entry is structurally identical to a
   * normal paid-but-unconfirmed entry and recovery would mis-route it through
   * `reVerifyPayment`. Fallback when this write was lost: re-parse the
   * `payment` top-level tag from `raw_event_json`.
   */
  delegated?: boolean;
  /**
   * Delegated jobs: the result text persisted BEFORE the pull while status
   * stays `paid`, so crash recovery can deliver without re-executing. May be
   * the empty string (spilled results ride `result_attachments`).
   */
  delivered_content?: string;
  /**
   * Delegated pull idempotency key + terminal bound, flushed together in phase
   * A of the two-phase pull (sign -> persist -> send). `pull_signature`
   * present implies the result state above is fully persisted. The height is a
   * `number` (JSON cannot serialize bigint; ~330M fits a double exactly) -
   * compare via `BigInt(entry.pull_last_valid_block_height)`.
   */
  pull_signature?: string;
  pull_last_valid_block_height?: number;
  created_at: number;
  retry_count: number;
}

const VALID_TRANSITIONS: Record<LedgerStatus, LedgerStatus[]> = {
  paid: ['executed', 'failed'],
  executed: ['delivered', 'failed'],
  delivered: [],
  failed: [],
};

export class JobLedger {
  private entries = new Map<string, LedgerEntry>();
  private path: string;

  /**
   * @param ledgerPath absolute path to the ledger file
   *   (typically `<agentDir>/.jobs.json`). Caller is responsible for
   *   resolving the agent directory via `@elisym/sdk/agent-store`.
   */
  constructor(ledgerPath: string) {
    this.path = ledgerPath;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const data = JSON.parse(raw) as Record<string, LedgerEntry>;
      for (const [id, entry] of Object.entries(data)) {
        this.entries.set(id, entry);
      }
    } catch (e: any) {
      // W4: Log warning on malformed ledger and backup corrupt file
      if (e?.code !== 'ENOENT') {
        console.warn(`  ! Ledger load warning: ${e?.message ?? 'unknown error'}`);
        try {
          const backupPath = this.path + '.corrupt.' + Date.now();
          renameSync(this.path, backupPath);
          // The backup inherits the original (possibly world-readable) perms,
          // so tighten it to owner-only - it still holds job content.
          chmodSync(backupPath, LEDGER_FILE_MODE);
        } catch {
          /* best effort backup */
        }
      }
    }
  }

  flush(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: LEDGER_DIR_MODE });
    const obj = Object.fromEntries(this.entries);
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: LEDGER_FILE_MODE });
    renameSync(tmp, this.path);
    // writeFileSync's `mode` is masked by the process umask, so an explicit
    // chmod after the rename guarantees owner-only perms regardless of umask.
    chmodSync(this.path, LEDGER_FILE_MODE);
  }

  recordPaid(entry: Omit<LedgerEntry, 'status' | 'retry_count'>): void {
    if (this.entries.has(entry.job_id)) {
      return;
    }
    this.entries.set(entry.job_id, { ...entry, status: 'paid', retry_count: 0 });
    this.flush();
  }

  updatePayment(jobId: string, netAmount?: number, paymentRequest?: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      if (netAmount !== undefined) {
        entry.net_amount = netAmount;
      }
      if (paymentRequest !== undefined) {
        entry.payment_request = paymentRequest;
      }
      this.flush();
    }
  }

  /** Flush the delegated discriminator (called inside the atomic nonce mark). */
  markDelegated(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.delegated = true;
      this.flush();
    }
  }

  /**
   * Persist a delegated job's result text BEFORE the pull, while status stays
   * `paid`. MUST be flushed strictly before `recordPullSignature` so a
   * persisted pull signature always implies the result is recoverable.
   */
  recordDeliveredContent(jobId: string, deliveredContent: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.delivered_content = deliveredContent;
      this.flush();
    }
  }

  /**
   * Phase-A persist of the two-phase pull: the signature (durable idempotency
   * key), its blockhash terminal bound, and the amount the pull moves - one
   * flush, BEFORE any bytes hit the network.
   */
  recordPullSignature(
    jobId: string,
    pullSignature: string,
    pullLastValidBlockHeight: number,
    netAmount: number,
  ): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.pull_signature = pullSignature;
      entry.pull_last_valid_block_height = pullLastValidBlockHeight;
      entry.net_amount = netAmount;
      this.flush();
    }
  }

  /** Attempt a state transition. Returns the entry if valid, undefined otherwise. */
  private transition(jobId: string, to: LedgerStatus): LedgerEntry | undefined {
    const entry = this.entries.get(jobId);
    if (!entry) {
      return undefined;
    }
    if (!VALID_TRANSITIONS[entry.status].includes(to)) {
      return undefined;
    }
    entry.status = to;
    return entry;
  }

  markExecuted(jobId: string, result: string): void {
    const entry = this.transition(jobId, 'executed');
    if (entry) {
      entry.result = result;
      this.flush();
    }
  }

  /**
   * Record the JSON-serialized file-result descriptor. Survives later
   * `markDelivered`/`markFailed` (which only null `result`).
   */
  recordAttachment(
    jobId: string,
    fields: { resultAttachment?: string; resultAttachments?: string[] },
  ): void {
    const entry = this.entries.get(jobId);
    if (!entry) {
      return;
    }
    if (fields.resultAttachment !== undefined) {
      entry.result_attachment = fields.resultAttachment;
    }
    if (fields.resultAttachments !== undefined) {
      entry.result_attachments = fields.resultAttachments;
    }
    this.flush();
  }

  markDelivered(jobId: string): void {
    const entry = this.transition(jobId, 'delivered');
    if (entry) {
      entry.result = undefined; // Free memory
      entry.delivered_content = undefined;
      this.flush();
    }
  }

  markFailed(jobId: string): void {
    const entry = this.transition(jobId, 'failed');
    if (entry) {
      entry.result = undefined; // Free memory
      entry.delivered_content = undefined;
      try {
        this.flush();
      } catch {
        /* disk full - in-memory state is still correct */
      }
    }
  }

  incrementRetry(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.retry_count++;
      this.flush();
    }
  }

  getStatus(jobId: string): LedgerStatus | undefined {
    return this.entries.get(jobId)?.status;
  }

  pendingJobs(): LedgerEntry[] {
    return [...this.entries.values()].filter((e) => e.status === 'paid' || e.status === 'executed');
  }

  /** Every entry, any status. Used to reconcile the used-nonce set on restart. */
  allEntries(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  /** Remove old delivered/failed entries (default: 7 days). */
  gc(maxAgeSecs = 7 * 24 * 60 * 60): void {
    this.pruneOldEntries(maxAgeSecs * 1000);
  }

  /**
   * Drop terminal entries (`delivered` / `failed`) whose `created_at`
   * predates `now - retentionMs`. Stuck non-terminal entries are never
   * pruned - recovery keeps retrying them until the retry budget runs
   * out, then they become terminal and are eligible on the next sweep.
   *
   * Returns the number of entries deleted, for observability.
   */
  pruneOldEntries(retentionMs: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - Math.floor(retentionMs / 1000);
    let deleted = 0;
    for (const [id, entry] of this.entries) {
      if (
        (entry.status === 'delivered' || entry.status === 'failed') &&
        entry.created_at < cutoff
      ) {
        this.entries.delete(id);
        deleted += 1;
      }
    }
    if (deleted > 0) {
      this.flush();
    }
    return deleted;
  }
}

/**
 * Defensive size cap for the used-nonce set. Sized well above
 * `paid-global-rate x MAX_PROOF_TTL` (2000 jobs / 10 min) so it is never hit
 * in normal operation; overflow evicts the OLDEST entry (never reject-on-full,
 * which would DoS a legitimate job). Process-local, like the reservation - see
 * the accepted-residual notes in docs/plans/delegated-job-payment.md.
 */
const NONCE_STORE_MAX_ENTRIES = 10_000;

/**
 * Durable single-use nonce set for delegated job payment. Keyed
 * `owner + ':' + nonce` (`:` is outside base58, so keys cannot alias). Each
 * entry is retained until its proof's `expiry + skew` - at least its maximum
 * acceptance time, so a pruned entry can never correspond to a
 * still-acceptable proof. The runtime's pre-check does a SYNCHRONOUS
 * `has` -> `markUsed` pair (no await between them), which is what makes the
 * nonce exactly-once across N concurrent same-nonce events.
 */
export class UsedNonceStore {
  /** key -> retain-until (unix seconds). Map order doubles as mark order for evict-oldest. */
  private entries = new Map<string, number>();
  private path: string;
  private maxEntries: number;

  constructor(noncePath: string, maxEntries = NONCE_STORE_MAX_ENTRIES) {
    this.path = noncePath;
    this.maxEntries = maxEntries;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number>;
      for (const [key, retainUntil] of Object.entries(data)) {
        if (typeof retainUntil === 'number' && Number.isFinite(retainUntil)) {
          this.entries.set(key, retainUntil);
        }
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        console.warn(`  ! Nonce store load warning: ${e?.message ?? 'unknown error'}`);
        try {
          const backupPath = this.path + '.corrupt.' + Date.now();
          renameSync(this.path, backupPath);
          chmodSync(backupPath, LEDGER_FILE_MODE);
        } catch {
          /* best effort backup */
        }
      }
    }
  }

  flush(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: LEDGER_DIR_MODE });
    const obj = Object.fromEntries(this.entries);
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj), { mode: LEDGER_FILE_MODE });
    renameSync(tmp, this.path);
    chmodSync(this.path, LEDGER_FILE_MODE);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Burn a nonce. Flushes by default; pass `persist: false` during bulk
   * restart reconciliation and call {@link flush} once at the end. Evicts the
   * oldest entry on overflow rather than rejecting.
   */
  markUsed(key: string, retainUntilSecs: number, opts: { persist?: boolean } = {}): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, retainUntilSecs);
    if (opts.persist !== false) {
      try {
        this.flush();
      } catch {
        /* disk full - the in-memory set still enforces single-use this process */
      }
    }
  }

  /** Drop entries past their retain-until. Returns the number pruned. */
  prune(nowSecs = Math.floor(Date.now() / 1000)): number {
    let pruned = 0;
    for (const [key, retainUntil] of this.entries) {
      if (retainUntil <= nowSecs) {
        this.entries.delete(key);
        pruned += 1;
      }
    }
    if (pruned > 0) {
      try {
        this.flush();
      } catch {
        /* disk full - in-memory state is still correct */
      }
    }
    return pruned;
  }

  size(): number {
    return this.entries.size;
  }
}
