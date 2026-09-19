/**
 * Job recovery ledger - persistent JSON storage for crash recovery.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { isBlockingNodeSync } from '@elisym/sdk/agent-store';

// Ledger files hold customer-confidential job content (inputs, results). Lock
// the directory and files down to owner-only, matching the rest of the agent
// store, so other local users cannot read them.
const LEDGER_DIR_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;

export type LedgerStatus = 'paid' | 'executed' | 'delivered' | 'failed';

/**
 * A signature this ledger can actually key a de-duplication claim on.
 *
 * Written once PER PACKAGE and imported everywhere rather than spelled out at
 * each gate, because the gates have to agree. (`@elisym/sdk` keeps its own copy
 * for its acceptor; it is not exported, so this is a deliberate second one, and
 * the two have to stay identical by hand.) They have to agree because: two of them differing by an
 * `=== undefined` instead of this would let an empty string through one and
 * not the other, and an empty string is the value that both a hand-edited
 * ledger and a proxy rewriting an RPC page produce. A claim keyed on one owns
 * nothing, so the transaction it stood for stays free for the next job to
 * settle against - the payment is accepted and the de-duplication record is
 * not written.
 */
export function isUsableSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

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
  /**
   * The on-chain settlement signature this job consumed on the FLAT paid path.
   * Written ONLY by an accepted {@link JobLedger.claimPaymentSignature}, whose
   * failed flush rolls it back - so its presence always means "this job owns
   * this settlement, and the ownership reached disk". This field IS the
   * de-duplication index (re-read into it on every load, so there is no second
   * store to lose); never cleared by `markDelivered`/`markFailed`, and optional
   * so pre-existing entries load unchanged.
   */
  payment_signature?: string;
  created_at: number;
  retry_count: number;
}

const VALID_TRANSITIONS: Record<LedgerStatus, LedgerStatus[]> = {
  paid: ['executed', 'failed'],
  executed: ['delivered', 'failed'],
  delivered: [],
  failed: [],
};

/**
 * Outcome of binding an on-chain settlement signature to a job.
 *   - `claimed`: this job owns the signature and the ownership is on disk
 *     (first claim, or a re-claim by the same job during re-confirmation or
 *     crash recovery).
 *   - `consumed-by-other`: another job already settled with this transaction.
 *     Nothing about it is attributable to the claiming job.
 *   - `not-persisted`: ownership could not be written to disk, so nothing was
 *     bound - neither on disk nor in memory. The caller must NOT treat the
 *     payment as accepted; the condition is transient and the same job (or a
 *     sibling that can equally verify the signature) may claim it later.
 *   - `unknown-job`: there is no ledger entry for this job id, so the claim has
 *     nowhere durable to live. A provider wiring bug (every paid job is
 *     `recordPaid` before payment collection), not a disk or customer state.
 *
 * Only `claimed` accepts a payment; the other three are refusals that differ
 * only in what the operator should go and look at.
 */
export type PaymentSignatureClaim =
  | 'claimed'
  | 'consumed-by-other'
  | 'not-persisted'
  | 'unknown-job';

/**
 * How many distinct double-settled signatures `indexPaymentSignatures` names at
 * load before it stops and reports a count instead. One line per duplicated
 * SIGNATURE is the useful signal; a corrupt ledger repeating the same handful
 * across thousands of entries is noise that hides every other startup message.
 */
const MAX_DOUBLE_SETTLE_WARNINGS = 20;

export class JobLedger {
  private entries = new Map<string, LedgerEntry>();
  /**
   * settlement signature -> the job that consumed it. Derived state, rebuilt
   * from `entries` on every {@link load} - the entries themselves are the
   * durable record.
   */
  private paymentSignatureOwners = new Map<string, string>();
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
    // BEFORE the try, and it throws rather than starting empty. A FIFO here
    // does not fail the read, it takes the event loop with it - and starting
    // with an EMPTY ledger would be worse than either: this index is what keeps
    // one transaction from paying two jobs.
    //
    // `cmdStart` opens this BEFORE it publishes anything, precisely so a
    // refusal cannot leave a live paid provider advertised by an agent that has
    // already exited. Outside the try because the `catch` below renames what it
    // cannot parse to `.corrupt.<ts>`, and somebody else's node is not ours to
    // move.
    if (isBlockingNodeSync(this.path)) {
      throw new Error(
        `Refusing to read the job ledger at ${this.path}: it is a pipe, socket or device, not a ` +
          `file. An empty ledger would drop the record of which transaction paid for which job.`,
      );
    }
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      let unusable = 0;
      for (const [id, entry] of Object.entries(data)) {
        // A hand-edited or third-party-written ledger can carry `null`, an array
        // or a bare string where an entry belongs. Reading a property off one
        // THROWS, and the index below is what decides whether a settlement has
        // already been spent - so an unguarded entry here is a money bug, not a
        // tidiness one: the throw used to land after `entries` was fully
        // populated, leaving the process alive with an index built only as far
        // as the bad value. Every settlement recorded after it then looked
        // unclaimed, and one transaction could settle a second job.
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          unusable += 1;
          continue;
        }
        const candidate = entry as LedgerEntry;
        // Ownership IS the job id, so an entry without one cannot own its
        // settlement. The two halves fail differently and both are wrong: a
        // MISSING id indexes the signature to `undefined`, which reads back as
        // "nobody has claimed this" and lets a second job spend the same
        // transaction; an EMPTY one indexes to `''`, which fails closed instead
        // and refuses the transaction to the job that really paid. Either way
        // the entry cannot be routed at all, so it never belongs in the
        // pending set.
        if (typeof candidate.job_id !== 'string' || candidate.job_id.length === 0) {
          unusable += 1;
          continue;
        }
        this.entries.set(id, candidate);
      }
      if (unusable > 0) {
        console.warn(
          `  ! Ledger load warning: skipped ${unusable} unusable ` +
            `${unusable === 1 ? 'entry' : 'entries'} in ${this.path} - not an object, or carrying ` +
            `no job id. They cannot be routed or recovered, and the next write will not preserve ` +
            `them: copy the file before restarting if its history matters.`,
        );
      }
    } catch (e: any) {
      // An I/O error is not a corrupt FILE. EACCES, EISDIR, EIO mean we could
      // not read the ledger at all, and starting empty there frees every
      // settlement it records - the same reasoning as the node-type gate above,
      // and the same answer the SDK's settlement store gives. Rotating it aside
      // would be worse still: the evidence moves out of the way too.
      //
      // The discriminator is the `code` field: `readFileSync` failures carry
      // one, `JSON.parse` failures do not. Only a file we READ and could not
      // PARSE is rotated and replaced, which is what the recovery below is for.
      if (typeof e?.code === 'string' && e.code !== 'ENOENT') {
        throw new Error(
          `Refusing to start on a job ledger that cannot be read (${e.code}) at ${this.path}. ` +
            `An empty ledger would drop the record of which transaction paid for which job. ` +
            `Check the file's owner and mode (a ledger written under sudo needs a chown).`,
        );
      }
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
    // OUTSIDE the catch, deliberately. This index is what refuses a settlement
    // another job already consumed, so a half-built one is worse than no agent
    // at all - and inside the try, any throw here would be swallowed as "corrupt
    // ledger", renaming the live file while the process carried on with whatever
    // part of the index had been built. On an unreadable or unparseable file
    // `entries` is empty and this is a no-op; anything that still throws now
    // takes the process down loudly instead of quietly under-protecting money.
    this.indexPaymentSignatures();
  }

  flush(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: LEDGER_DIR_MODE });
    const obj = Object.fromEntries(this.entries);
    // The temporary carries a RANDOM suffix, exactly as `writeFileAtomic` in
    // the SDK does, and that is a safety property rather than a nicety:
    // `writeFileSync` onto a FIFO never returns - it takes the whole event loop
    // with it - so a predictable temporary name is a way to hang this process
    // from outside. Reading is gated by node type; writing is protected by
    // there being nothing to plant.
    const tmp = `${this.path}.tmp.${randomBytes(6).toString('hex')}`;
    // Cleaned up on any failure below, and that only became worth doing once
    // the name became random: with one fixed name the next flush reused the
    // leftover, so the garbage bounded itself. Now every failure between the
    // write and the rename would leave a unique file holding a full copy of the
    // ledger - customer inputs included - and nothing ever sweeps them.
    // The chmod is NOT about a stale temporary any more - the name is random,
    // so there is never one to reuse. What it still does is undo the umask:
    // `writeFileSync`'s `mode` is a request, and a umask of 0o200 would leave
    // the ledger read-only to its own owner. It runs on the TEMP file so that
    // `renameSync` stays the LAST statement and the whole method is
    // all-or-nothing.
    //
    // That ordering is not tidiness. `claimPaymentSignature` rolls itself back
    // when this throws, on the understanding that a failed flush wrote nothing.
    // chmod the live file after the rename instead and a failure throws once the
    // new content is already published: the claim would be undone in memory
    // while standing on disk, freeing a sibling job to claim the same on-chain
    // transaction and flush it. One transaction, two jobs - the exact thing the
    // claim exists to prevent.
    //
    // `UsedNonceStore.flush` deliberately keeps the opposite order; see there.
    try {
      writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: LEDGER_FILE_MODE });
      chmodSync(tmp, LEDGER_FILE_MODE);
      renameSync(tmp, this.path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort: the caller's error is the one worth reporting */
      }
      throw error;
    }
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

  /**
   * Build the settlement-signature index from the loaded entries. A signature
   * recorded on two entries is the on-disk fingerprint of a double settle -
   * shout about it rather than silently picking a winner, but once per SIGNATURE
   * and capped overall: a corrupt ledger repeating one signature across
   * thousands of entries buried every other startup line under ~30 000
   * identical warnings. The suppressed count is reported at the end.
   */
  private indexPaymentSignatures(): void {
    const warnedSignatures = new Set<string>();
    let suppressed = 0;
    for (const entry of this.entries.values()) {
      const paymentSignature = entry.payment_signature;
      // Index STRINGS only: a hand-edited ledger can carry a number, object or
      // null here, and keying the map on one blocks a slot no ordinary claim can
      // ever collide with. Ignoring it just means the entry owns nothing.
      if (!isUsableSignature(paymentSignature)) {
        continue;
      }
      const owner = this.paymentSignatureOwners.get(paymentSignature);
      if (owner !== undefined && owner !== entry.job_id) {
        if (warnedSignatures.has(paymentSignature)) {
          continue;
        }
        warnedSignatures.add(paymentSignature);
        if (warnedSignatures.size > MAX_DOUBLE_SETTLE_WARNINGS) {
          suppressed += 1;
          continue;
        }
        console.warn(
          `  ! DOUBLE SETTLE in the ledger: on-chain settlement ${paymentSignature} is recorded ` +
            `for BOTH job ${owner} and job ${entry.job_id}. One transaction must settle only one ` +
            `job - audit both before trusting this agent's payment history.`,
        );
        continue;
      }
      this.paymentSignatureOwners.set(paymentSignature, entry.job_id);
    }
    if (suppressed > 0) {
      console.warn(
        `  ! DOUBLE SETTLE: ${suppressed} further duplicated settlement signature(s) not listed. ` +
          `This ledger is corrupt - audit it in full.`,
      );
    }
  }

  /** The job that consumed `paymentSignature`, or undefined when unclaimed. */
  paymentSignatureOwner(paymentSignature: string): string | undefined {
    return this.paymentSignatureOwners.get(paymentSignature);
  }

  /**
   * Bind an on-chain settlement signature to exactly one job - the whole of
   * "one transaction settles one job" for the FLAT paid path. It exists because
   * the SDK verifier is stateless by contract (see
   * `PaymentStrategy.verifyPayment`), so one transfer carrying N job references
   * verifies for all N and only the provider can pick the single job it settles.
   *
   * The exactly-once property comes from this method being SYNCHRONOUS: index
   * read and write-back happen in one uninterrupted turn of the event loop, so
   * N concurrent jobs presenting the same signature serialize and exactly one
   * wins - the same shape as {@link UsedNonceStore}'s `has` -> `markUsed` pair.
   * Never make this async.
   *
   * SCOPE: one ledger file, i.e. one agent directory, in one process. Two
   * `elisym start` processes sharing a directory are deliberately not
   * serialized against each other (no cross-process lock) - run one per agent
   * directory. Separate directories are separate providers with separate
   * wallets, so they have nothing to de-duplicate in common.
   *
   * A re-claim by the SAME job always succeeds: live re-confirmation and crash
   * recovery re-verifying its own payment must both keep working.
   *
   * A job that claims a SECOND, DIFFERENT signature RELEASES the first one's
   * index mark, because the entry carries exactly one `payment_signature` and
   * the index must not outlive the entry field that justifies it - the prune
   * path relies on "every mark corresponds to a persisted `payment_signature`".
   * Releasing it is safe, not generous: a second claim is only reachable while
   * the job is still unconfirmed (`net_amount` unset, which is the only state
   * that re-runs verification), so the released signature settled nothing and
   * is exactly as unowned as it was before this job ever looked at it.
   *
   * That release is guarded on OWNERSHIP, and so is its rollback. On a ledger
   * that already double-settles (two entries carrying one signature -
   * `indexPaymentSignatures` warns and keeps the first as owner), this entry's
   * `payment_signature` can name a mark another job holds. Releasing it
   * unguarded would free a settlement the rightful owner still needs, and
   * re-assigning it unguarded on a failed flush would hand that owner's mark to
   * this job - refusing the owner its own settlement until the next restart.
   */
  claimPaymentSignature(paymentSignature: string, jobId: string): PaymentSignatureClaim {
    // Entry existence FIRST. `unknown-job` is a provider wiring bug and
    // `consumed-by-other` a customer/attacker state; checking the index first
    // would report the second when the truth is the first, sending the operator
    // to audit a payment dispute that does not exist.
    const entry = this.entries.get(jobId);
    if (entry === undefined) {
      return 'unknown-job';
    }
    const owner = this.paymentSignatureOwners.get(paymentSignature);
    if (owner !== undefined && owner !== jobId) {
      return 'consumed-by-other';
    }
    const previousSignature = entry.payment_signature;
    // Past the guard above, `owner` IS the pre-mutation owner of this signature -
    // either nobody, or this job re-claiming what it already holds - so the
    // rollback reads it instead of looking the same key up a second time and
    // reading as an independent fact.
    const previousOwner = owner;
    // Resolved BEFORE any mutation: only a mark this job actually holds is ours
    // to release, and the same answer must drive the rollback below.
    const releasedSignature =
      typeof previousSignature === 'string' &&
      previousSignature !== paymentSignature &&
      this.paymentSignatureOwners.get(previousSignature) === jobId
        ? previousSignature
        : undefined;
    this.paymentSignatureOwners.set(paymentSignature, jobId);
    if (releasedSignature !== undefined) {
      this.paymentSignatureOwners.delete(releasedSignature);
    }
    entry.payment_signature = paymentSignature;
    try {
      this.flush();
    } catch {
      // Fail closed, and roll BOTH sides back. The entry field must not stay
      // assigned, or the next unrelated flush would quietly persist a settlement
      // this job was refused. The in-memory mark goes with it: a restart
      // discards it anyway, so holding it would only block - for the life of
      // this process - a sibling job that can verify the same signature and is
      // equally entitled to it. Self-healing either way: the same job re-claiming
      // once the disk is writable flushes and wins.
      entry.payment_signature = previousSignature;
      if (previousOwner === undefined) {
        this.paymentSignatureOwners.delete(paymentSignature);
      } else {
        this.paymentSignatureOwners.set(paymentSignature, previousOwner);
      }
      // ...including the mark this claim would have released. A refused claim
      // must leave the index exactly as it found it, or a failed disk write
      // would silently hand the job's earlier settlement to someone else.
      if (releasedSignature !== undefined) {
        this.paymentSignatureOwners.set(releasedSignature, jobId);
      }
      return 'not-persisted';
    }
    return 'claimed';
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
    const prunedSignatures = new Set<string>();
    let deleted = 0;
    for (const [id, entry] of this.entries) {
      if (
        (entry.status === 'delivered' || entry.status === 'failed') &&
        entry.created_at < cutoff
      ) {
        this.entries.delete(id);
        if (isUsableSignature(entry.payment_signature)) {
          prunedSignatures.add(entry.payment_signature);
        }
        deleted += 1;
      }
    }
    if (prunedSignatures.size > 0) {
      this.releasePrunedPaymentSignatures(prunedSignatures);
    }
    if (deleted > 0) {
      this.flush();
    }
    return deleted;
  }

  /**
   * Release the index marks of PRUNED entries, so the index cannot outgrow the
   * ledger. Every mark corresponds to a persisted `payment_signature` (a claim
   * whose flush failed rolls both back), so the entries are the whole story.
   * Safe: `LEDGER_RETENTION_MS` is far past Solana's ~2-3 day history horizon,
   * so a pruned signature can no longer verify for any job. A signature still
   * carried by a SURVIVING entry (the fingerprint of a double settle) is kept
   * whoever owns it - pruning one side must never hand the transaction to a
   * third job.
   */
  private releasePrunedPaymentSignatures(prunedSignatures: ReadonlySet<string>): void {
    const survivingSignatures = new Set<string>();
    for (const entry of this.entries.values()) {
      if (typeof entry.payment_signature === 'string') {
        survivingSignatures.add(entry.payment_signature);
      }
    }
    for (const paymentSignature of prunedSignatures) {
      if (!survivingSignatures.has(paymentSignature)) {
        this.paymentSignatureOwners.delete(paymentSignature);
      }
    }
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
    // Same gate as the job ledger, and the same reasoning: this index is what
    // makes a delegated pull single-use, so an empty one is not a safe default.
    if (isBlockingNodeSync(this.path)) {
      throw new Error(
        `Refusing to read the nonce store at ${this.path}: it is a pipe, socket or device, not a ` +
          `file. An empty store would let a delegated pull be replayed.`,
      );
    }
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number>;
      for (const [key, retainUntil] of Object.entries(data)) {
        if (typeof retainUntil === 'number' && Number.isFinite(retainUntil)) {
          this.entries.set(key, retainUntil);
        }
      }
    } catch (e: any) {
      // Same split as the job ledger: a file we could not READ is refused, a
      // file we read and could not PARSE is rotated aside and replaced.
      if (typeof e?.code === 'string' && e.code !== 'ENOENT') {
        throw new Error(
          `Refusing to start on a nonce store that cannot be read (${e.code}) at ${this.path}. ` +
            `An empty store would let a delegated pull be replayed. Check the file's owner and ` +
            `mode (a store written under sudo needs a chown).`,
        );
      }
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
    // Random suffix for the same reason as `JobLedger.flush`.
    const tmp = `${this.path}.tmp.${randomBytes(6).toString('hex')}`;
    // The REVERSE of `JobLedger.flush`, and deliberately so. This store's only
    // writers (`markUsed`, `prune`) swallow a flush failure and KEEP the
    // in-memory mark, because an unpersisted nonce still enforces single-use for
    // the life of the process. Publishing the data first is therefore the safe
    // order: a chmod that fails afterwards leaves disk and memory agreeing that
    // the nonce is spent. Make this all-or-nothing like the job ledger and the
    // failure mode inverts - the mark lives only in memory, a restart forgets
    // it, and a delegated pull can be replayed.
    // The write and the RENAME are wrapped, and the chmod stays AFTER the
    // rename so the order above is preserved. Being outside the `try` changes
    // nothing on its own - it throws out of `flush` either way, and the cleanup
    // would find nothing to remove - so the load-bearing half is the position,
    // not the bracket. The cleanup exists because the temporary now carries a
    // random name and would otherwise be left behind for good.
    try {
      writeFileSync(tmp, JSON.stringify(obj), { mode: LEDGER_FILE_MODE });
      renameSync(tmp, this.path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw error;
    }
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
