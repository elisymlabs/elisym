/**
 * Provider-side payment recovery for the FLAT paid path.
 *
 * Two jobs, deliberately kept out of `runtime.ts`:
 *
 *   1. binding an on-chain settlement to exactly one job, and deciding - from a
 *      reference the whole world can read - whether a `paid` entry has actually
 *      been paid. The SDK verifier is stateless by contract (see
 *      `PaymentStrategy.verifyPayment`), so one transfer carrying N job
 *      references verifies for all N and only the provider, which knows what
 *      its ledger already spent, can pick the single job it settles;
 *   2. bounding what that costs. A scan is an RPC listing plus a transaction
 *      fetch per candidate, all of it on a `p-limit` slot shared with live
 *      intake, so a backlog of entries that cannot be confirmed must not
 *      answer paying customers with "Server overloaded".
 *
 * Nothing here touches skills, transports, sessions, delegation or the LLM
 * health monitor; the runtime keeps the routing and the ledger keeps the
 * durable state.
 */
import { DEFAULTS, calculateProtocolFee, degenerateReference } from '@elisym/sdk';
import type {
  Network,
  PaymentRequestData,
  PaymentStrategy,
  ProtocolConfigInput,
  VerifyResult,
} from '@elisym/sdk';
import { address as asAddress, createSolanaRpc } from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { getRpcUrl } from './helpers.js';
import type { JobLedger, LedgerEntry, PaymentSignatureClaim } from './ledger.js';
import { isUsableSignature } from './ledger.js';

// --- Constants ---

/**
 * Signatures listed in ONE provider-side reference scan - a single
 * `getSignaturesForAddress` window. Deliberately THE SDK's own window
 * (`DEFAULTS.VERIFY_SIGNATURE_LIMIT`) rather than a private copy of the number:
 * the provider's advantage is not a bigger window but that only it knows which
 * signatures its ledger already spent, and can look past them inside the
 * window. Paging further only moved the flood threshold from 25 to 100
 * transactions - pennies either way - for a verify loop four times as long.
 */
export const REFERENCE_SCAN_WINDOW = DEFAULTS.VERIFY_SIGNATURE_LIMIT;
/**
 * Attempts at the `getSignaturesForAddress` LISTING that opens a scan. The
 * whole terminal "nobody paid" verdict rests on this one call, and the public
 * RPC is known to throttle and lag this exact index (see the note in
 * `transport/nostr.ts`), so a single shot deciding a job's fate is not enough.
 * Cheap: retries only happen when the call actually failed.
 */
export const REFERENCE_SCAN_LIST_ATTEMPTS = 3;
/** Pause between failed listing attempts. Short - the whole scan has a deadline. */
export const REFERENCE_SCAN_LIST_RETRY_DELAY_MS = 400;
/**
 * Retry budget for ONE scan candidate - deliberately the SAME budget the
 * listing gets, because the two failures are the same failure. The SDK reports
 * "I fetched this transaction and it is not a payment" and "I could not reach
 * the chain" as the same `{verified: false, error}`, so a candidate starved by
 * a throttling RPC is indistinguishable from a rejected one; giving it fewer
 * attempts than the listing that found it would make a flaky RPC look like
 * evidence. Not the SDK default of 10 attempts either: that is ~30s per
 * candidate on a `p-limit` slot shared with live intake, and the scan deadline
 * would eat it long before the window was walked.
 */
export const REFERENCE_SCAN_VERIFY_RETRIES = REFERENCE_SCAN_LIST_ATTEMPTS;
/**
 * Retry budget for the one signature a job ALREADY OWNS. That is a known
 * payment, not a guess, so it is worth more than a candidate - but not the SDK
 * default of 10 x 3s, which spends 30s of a shared `p-limit` slot on every tick
 * once the settlement has aged out of the RPC's history window.
 */
export const OWN_SETTLEMENT_VERIFY_RETRIES = REFERENCE_SCAN_VERIFY_RETRIES + 2;
/**
 * Wall-clock ceiling for a whole reference scan (listing plus every candidate,
 * plus the re-check of a settlement the job already owns). A healthy RPC answers
 * a window of candidates in seconds; past 30s it is rate-limiting us, and the
 * scan returns INCONCLUSIVE instead of holding a shared slot for minutes.
 */
export const REFERENCE_SCAN_DEADLINE_MS = 30_000;
/**
 * Genesis hash of each cluster the CLI can be pointed at - the standard, single
 * cheap call that asks an endpoint "which chain are you?". `SOLANA_RPC_URL` is
 * an environment variable nothing checks, so without this the terminal "nobody
 * paid" verdict rests on whatever host that string happened to name.
 */
export const CLUSTER_GENESIS_HASHES: Record<Network, string> = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};

/**
 * The address the endpoint's transaction-history index is probed against: the
 * System program, which is in the account keys of essentially every transaction
 * on every cluster, so it exercises the same `getSignaturesForAddress` index the
 * whole verdict rests on.
 *
 * The probe only requires the call to ANSWER, not to return anything. A node
 * with transaction history disabled errors on it ("Transaction history is not
 * available from this node"), which is the failure being guarded; requiring a
 * NON-EMPTY page would additionally make a paying customer's job depend on
 * third-party traffic to an address elisym does not control.
 */
export const ADDRESS_HISTORY_PROBE_ADDRESS = '11111111111111111111111111111111';

/**
 * Per-entry backoff for recovery ticks that ended INCONCLUSIVE, counted in
 * RECOVERY TICKS. A deferred entry re-runs a full reference scan and (once paid)
 * a skill preflight, on a `p-limit` slot shared with live intake, so retrying
 * every tick for 24h lets a few stuck entries starve paying customers. Ticks
 * rather than milliseconds so the ladder never resolves to less than one tick,
 * which is no backoff at all; the 24h `MAX_PAID_AGE_MS` cutoff remains the
 * terminal backstop.
 *
 * Jitter (`RECOVERY_DEFER_JITTER_TICKS`) means a rung of N lands on the Nth or
 * (N+1)th tick after the deferral - see {@link recoveryDeferDelayMs}. At the
 * default 60s cadence that is roughly 1 to 61 minutes.
 */
export const RECOVERY_DEFER_BACKOFF_TICKS = [1, 2, 5, 15, 30, 60];
/**
 * Half-width of the deferral jitter, in ticks. Without it every entry deferred
 * on the same tick stays in lockstep forever and becomes due on the same later
 * tick - the herd this jitter exists to break up. Half a tick is the widest
 * spread that still keeps a rung of N from landing before its Nth tick.
 */
export const RECOVERY_DEFER_JITTER_TICKS = 0.5;
/**
 * Lowest rung the ladder may use for the wait AFTER a complete, empty scan past
 * the customer's deadline - the one observation that can become terminal, and
 * whose repeat closes a paid job.
 *
 * Two such looks one tick apart are barely independent, and independence is the
 * entire reason a second one is required: the public RPC lags this very index,
 * so a transaction confirmed in the last seconds of the window can be missing
 * from two listings a minute apart and present on the third. The ladder used to
 * supply that spacing by accident, because in-window scans climbed it before the
 * deadline ever passed; now that they deliberately do not (see
 * {@link RecoveryDeferrals.noteAwaitingWindow}), it has to be asked for. Rung 3
 * is 5 ticks - five minutes at the default cadence - and only the WAIT is
 * floored, never the attempt count the ladder itself keeps climbing.
 */
export const TERMINAL_CONFIRMATION_MIN_RUNG = 3;
/**
 * Share of the runtime's job concurrency that one recovery tick may spend on
 * PAYMENT RE-SCANS, counted separately from live intake. A scan is an RPC
 * listing plus a fetch per candidate, all of it holding a `p-limit` slot and a
 * queue slot shared with paying customers; a restart, which forgets every
 * deferral, would otherwise start one for every pending entry at once and answer
 * live jobs with "Server overloaded". Half leaves the other half of the
 * runtime's capacity for live work.
 */
const RECOVERY_SCAN_BUDGET_DIVISOR = 2;

/**
 * How many payment re-scans ONE recovery tick may start: half the runtime's job
 * concurrency, and never zero - a budget of zero would park every entry forever
 * and no payment would ever be confirmed.
 *
 * NOT an operator knob. `RuntimeConfig.maxConcurrentJobs` is a compile-time
 * constant (`MAX_CONCURRENT_JOBS`, 10) that `start.ts` passes verbatim and
 * nothing reads from agent config or the environment, so in a real agent this is
 * always 5. It is a parameter rather than a constant so the derivation stays one
 * expression if that ever becomes configurable, and so tests can pin the
 * derivation itself.
 *
 * Entries over the budget are parked (see
 * {@link RecoveryDeferrals.parkForCapacity}); this budget, not that park, is
 * what spreads a restart's backlog across ticks: the Nth pending entry gets its
 * first scan roughly `N / budget` ticks after startup.
 */
export function recoveryScanBudgetPerTick(maxConcurrentJobs: number): number {
  return Math.max(1, Math.floor(maxConcurrentJobs / RECOVERY_SCAN_BUDGET_DIVISOR));
}

/**
 * Delay before a deferred recovery entry may be re-scanned, in milliseconds.
 *
 * `attempts` is how many consecutive inconclusive ticks this entry has had (1 on
 * the first deferral). `jitter` is a caller-supplied value in `[-1, 1]`, scaled
 * by `RECOVERY_DEFER_JITTER_TICKS`; injected rather than read from `Math.random`
 * so the ladder itself is testable.
 *
 * The rung index is CLAMPED to the last rung: past it the lookup would be out of
 * range, and an entry parked forever would fall back to re-scanning every tick -
 * the exact cost the ladder exists to bound. That clamp is the only guard here;
 * `attempts >= 1` and `|jitter| <= 1` are the caller's contract, so neither a
 * negative rung index nor a negative delay is reachable and neither is guarded
 * against. (`?? 1` is TypeScript's required index-access default, not a branch:
 * the clamp above already makes the lookup total.)
 */
export function recoveryDeferDelayMs(
  attempts: number,
  recoveryIntervalSecs: number,
  jitter: number,
): number {
  const rung = Math.min(attempts, RECOVERY_DEFER_BACKOFF_TICKS.length) - 1;
  const ticks = RECOVERY_DEFER_BACKOFF_TICKS[rung] ?? 1;
  const intervalMs = recoveryIntervalSecs * 1000;
  const jitterMs = jitter * RECOVERY_DEFER_JITTER_TICKS * intervalMs;
  return ticks * intervalMs + jitterMs;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// --- Scan outcomes ---

/**
 * Outcome of a PROVIDER-SIDE reference scan - the `getSignaturesForAddress`
 * listing the CLI walks itself instead of delegating to the SDK's
 * first-match-wins reference path, which cannot be asked for the NEXT
 * transaction. Only the provider knows which signatures it has already
 * consumed, so only the provider can skip them and keep walking the window.
 *
 *   - `verified`: a candidate this job may own verified on-chain. The scan
 *     names the settlement itself (the candidate it just checked), so unlike
 *     the SDK's `VerifyResult` there is no "verified but unnamed" case.
 *   - `none`: the scan saw the reference's WHOLE history (the listing succeeded
 *     and came back short of the window, so nothing is hidden behind a
 *     truncated page), skipped nothing another job owns, fetched every
 *     candidate, and found nothing that could be a payment. The one shape that
 *     may lead to a terminal verdict - and only after the payment request's own
 *     expiry has passed and on a second consecutive sighting, see
 *     {@link PaymentRecovery.reVerifyPayment} and its caller.
 *   - `inconclusive`: an RPC failure, an abort, the scan deadline, a candidate
 *     another job already consumed, a candidate that did not verify (which the
 *     SDK cannot distinguish from one it could not fetch), or a window so full
 *     that a payment could be hidden behind the flood. Says nothing about the
 *     customer.
 */
export type ReferenceScan =
  | { outcome: 'verified'; txSignature: string }
  | { outcome: 'none' }
  | { outcome: 'inconclusive'; error: string };

/**
 * Outcome of re-verifying a `paid` entry's payment during crash recovery.
 *   - `verified`: the payment is confirmed and claimed for this job.
 *   - `no-payment`: a scan that saw the reference's whole history, after the
 *     payment request's own expiry, and found nothing that could be a payment.
 *     Not terminal by itself - the caller requires a SECOND consecutive
 *     sighting before failing the job.
 *   - `deferred`: inconclusive (an abort, an RPC error, a candidate that did not
 *     verify, a disk write we could not make, or a transaction another job
 *     already consumed). The entry stays `paid` and the next tick tries again;
 *     the `MAX_PAID_AGE_MS` cutoff bounds the wait. Nothing here is evidence the
 *     customer failed to pay.
 *   - `awaiting-window`: the reference's whole history is empty, but the payment
 *     request this provider issued has not expired yet. Held back like
 *     `deferred`, and deliberately NOT on the same ladder - see
 *     {@link RecoveryDeferrals.noteAwaitingWindow}.
 *   - `corrupt-state`: OUR persisted state is unusable (`payment_request` is not
 *     JSON, or its `reference` is not an address). No amount of waiting fixes
 *     it, so the entry fails now instead of burning a 24h slot.
 */
export type PaymentReVerification =
  | 'verified'
  | 'no-payment'
  | 'deferred'
  | 'awaiting-window'
  | 'corrupt-state';

/**
 * Whether one recovery tick would spend an RPC reference scan on this entry - a
 * `paid` entry whose payment request is persisted but whose payment is not yet
 * confirmed, and which is not reconciled through the delegated pull path (that
 * path never reads the reference). Deliberately cheap and slightly
 * over-inclusive: it does not route the skill, because all it decides is
 * whether the entry competes for the per-tick scan budget.
 *
 * `delegated` is passed in rather than derived here: the delegated
 * discriminator belongs to the runtime's recovery routing, not to this
 * subsystem.
 */
export function needsPaymentScan(
  entry: { status: string; net_amount?: number; payment_request?: string },
  delegated: boolean,
): boolean {
  return (
    entry.status === 'paid' &&
    !entry.net_amount &&
    entry.payment_request !== undefined &&
    !delegated
  );
}

/**
 * Operator-facing sentence for a settlement claim that was REFUSED. The enum
 * values are internal control flow; an operator reading "settlement claim
 * refused (not-persisted)" at 3am learns nothing about what to go and fix.
 */
export function claimRefusalSentence(claim: Exclude<PaymentSignatureClaim, 'claimed'>): string {
  switch (claim) {
    case 'consumed-by-other':
      return (
        'the transaction carrying this job reference was already consumed by another job, so it ' +
        'is not attributable here'
      );
    case 'not-persisted':
      return (
        'the claim on that settlement could not be written to disk, so the payment was refused ' +
        'rather than risk delivering twice for one transfer'
      );
    case 'unknown-job':
      return 'this job has no ledger entry, so the claim had nowhere durable to live';
  }
}

/** What a payment the strategy verified but could not NAME is called in a log. */
export const UNNAMED_SETTLEMENT_SENTENCE =
  'the payment verified without a settlement signature, so it cannot be bound to one job';

// --- Deferral bookkeeping ---

/** One entry's deferral state. Read-only outside {@link RecoveryDeferrals}. */
export interface RecoveryDeferral {
  /** Consecutive INCONCLUSIVE ticks. A capacity park does not advance it. */
  readonly attempts: number;
  /** Earliest wall-clock time the next attempt may run. */
  readonly nextAttemptAt: number;
  /** When the entry was first held back, for the operator summary. */
  readonly firstDeferredAt: number;
  /** Whether the LAST attempt saw a complete, empty reference history. */
  readonly sawNoPayment: boolean;
}

/**
 * The recovery loop's backoff bookkeeping: which `paid` entries are being held
 * back, for how long, and what the last look at them saw.
 *
 * In memory only. A deferral is a statement about the current tick's luck, so a
 * restart is entitled to try again - the per-tick scan budget, not this map, is
 * what stops a restart from starting every scan at once. Bounded by the pending
 * set via {@link sweep}.
 */
export class RecoveryDeferrals {
  private readonly deferrals = new Map<string, RecoveryDeferral>();

  /**
   * `recoveryIntervalSecs` is read through a function because the backoff
   * ladder is counted in TICKS and the runtime owns the tick length.
   * `random` returns `[0, 1)`; injected so the jitter is testable.
   */
  constructor(
    private readonly recoveryIntervalSecs: () => number,
    private readonly random: () => number = Math.random,
  ) {}

  /** How many entries are currently held back. */
  get size(): number {
    return this.deferrals.size;
  }

  /** This entry's deferral state, or undefined when it is not held back. */
  peek(jobId: string): RecoveryDeferral | undefined {
    return this.deferrals.get(jobId);
  }

  /**
   * Record that a recovery tick ended INCONCLUSIVE for this entry and push its
   * next attempt out by the backoff ladder.
   *
   * A deferral is cheap to decide and expensive to repeat: a full reference
   * scan (an RPC listing plus a transaction fetch per candidate) holding a
   * `p-limit` slot and a queue slot shared with live intake. Repeating that
   * every 60s for 24h is how a handful of stuck entries turns into "Server
   * overloaded" for paying customers. Retries are still NOT burned - a deferral
   * is never evidence against the customer - the wait simply lengthens.
   *
   * `sawNoPayment` carries forward the one observation that can ever become
   * terminal, and is cleared by any other outcome - that is what "two
   * CONSECUTIVE clean empty scans" means.
   */
  note(jobId: string, sawNoPayment = false): void {
    const previous = this.deferrals.get(jobId);
    const attempts = (previous?.attempts ?? 0) + 1;
    // The stored count always advances; only the WAIT is floored, and only when
    // the look just taken could make the NEXT one terminal - see
    // {@link TERMINAL_CONFIRMATION_MIN_RUNG}.
    const delayMs = recoveryDeferDelayMs(
      sawNoPayment ? Math.max(attempts, TERMINAL_CONFIRMATION_MIN_RUNG) : attempts,
      this.recoveryIntervalSecs(),
      this.random() * 2 - 1,
    );
    this.deferrals.set(jobId, {
      attempts,
      nextAttemptAt: Date.now() + delayMs,
      firstDeferredAt: previous?.firstDeferredAt ?? Date.now(),
      sawNoPayment,
    });
  }

  /**
   * Record a scan that found an empty reference INSIDE the payment window this
   * provider itself advertised.
   *
   * Deliberately off the backoff ladder. The ladder counts inconclusive looks -
   * moments where the chain, the RPC or our own disk let us down - and "the
   * customer still has eight of their ten minutes left" is none of those: it is
   * the expected state of an ordinary job that nobody has paid yet. Counting it
   * cost twice over. A customer whose wallet confirms four minutes in was not
   * looked at again until minute nine, because the ladder had already climbed to
   * its 5-tick rung while they were still entitled to pay. And a job nobody ever
   * pays reached its expiry already parked on a 15- or 30-tick rung, so the two
   * consecutive scans that close it landed the better part of an hour later -
   * holding a `paid` entry, and its recovery slot, for all of it.
   *
   * So: hold the entry back for one tick, leave `attempts` where it is, and let
   * the ladder start climbing only once the window is actually over. The cost is
   * one `getSignaturesForAddress` per tick per unpaid job for the length of the
   * window (ten minutes by default) - an empty scan fetches no transactions -
   * and the per-tick scan budget still bounds how many run at once.
   *
   * `sawNoPayment` is cleared for the same reason it is cleared on any other
   * inconclusive outcome: this scan must never count toward the two consecutive
   * sightings that fail a job, because it was taken before the customer's
   * deadline.
   */
  noteAwaitingWindow(jobId: string): void {
    const previous = this.deferrals.get(jobId);
    const delayMs = recoveryDeferDelayMs(1, this.recoveryIntervalSecs(), this.random() * 2 - 1);
    this.deferrals.set(jobId, {
      attempts: previous?.attempts ?? 0,
      nextAttemptAt: Date.now() + delayMs,
      firstDeferredAt: previous?.firstDeferredAt ?? Date.now(),
      sawNoPayment: false,
    });
  }

  /**
   * Park an entry whose payment re-scan did not fit in this tick's scan budget.
   *
   * NOT a deferral: nothing was attempted, so the ladder does not advance and
   * the `sawNoPayment` observation is neither set nor cleared. The wait is
   * deliberately SUB-TICK, so a parked entry is due again by the next tick
   * rather than pushed minutes into the future for a queue that was merely
   * busy. What spreads a restart's backlog across ticks is the per-tick budget
   * itself (see {@link recoveryScanBudgetPerTick}), not this wait; the jitter
   * only stops a whole parked batch from becoming due on the same millisecond.
   */
  parkForCapacity(jobId: string): void {
    const previous = this.deferrals.get(jobId);
    const jitteredMs = this.random() * this.recoveryIntervalSecs() * 1000;
    this.deferrals.set(jobId, {
      attempts: previous?.attempts ?? 0,
      nextAttemptAt: Date.now() + jitteredMs,
      firstDeferredAt: previous?.firstDeferredAt ?? Date.now(),
      sawNoPayment: previous?.sawNoPayment ?? false,
    });
  }

  /**
   * Forget this entry's deferral state entirely. Called when the entry stops
   * being deferred at all - its payment confirmed - so the backlog summary's
   * "oldest deferred" cannot keep ageing on an entry nobody is holding back.
   */
  clear(jobId: string): void {
    this.deferrals.delete(jobId);
  }

  /** Whether the LAST attempt on this entry saw a complete, empty reference history. */
  sawNoPayment(jobId: string): boolean {
    return this.deferrals.get(jobId)?.sawNoPayment === true;
  }

  /** Whether this entry is still inside its deferral backoff window. */
  isDeferred(jobId: string): boolean {
    const deferral = this.deferrals.get(jobId);
    return deferral !== undefined && Date.now() < deferral.nextAttemptAt;
  }

  /**
   * Drop the state of entries that have left the pending set (delivered,
   * failed, pruned), keeping this map bounded by the pending set rather than by
   * the ledger's whole history.
   */
  sweep(stillPending: ReadonlySet<string>): void {
    if (this.deferrals.size === 0) {
      return;
    }
    for (const jobId of [...this.deferrals.keys()]) {
      if (!stillPending.has(jobId)) {
        this.deferrals.delete(jobId);
      }
    }
  }

  /**
   * One line per tick summing up the backlog, or `null` when there is nothing
   * to say. A pinned entry otherwise produces the same per-entry line as a
   * flaky RPC, roughly thirty times a day, and an operator has no way to tell
   * "one job is stuck" from "the chain is unreachable". The oldest age is the
   * number that matters: it says how close the backlog is to the 24h cutoff.
   */
  summaryLine(): string | null {
    if (this.deferrals.size === 0) {
      return null;
    }
    let oldestFirstDeferredAt = Number.POSITIVE_INFINITY;
    for (const deferral of this.deferrals.values()) {
      oldestFirstDeferredAt = Math.min(oldestFirstDeferredAt, deferral.firstDeferredAt);
    }
    const oldestMinutes = Math.floor((Date.now() - oldestFirstDeferredAt) / 60_000);
    const noun = this.deferrals.size === 1 ? 'job is' : 'jobs are';
    return (
      `Recovery: ${this.deferrals.size} ${noun} deferred awaiting payment confirmation ` +
      `(oldest deferred ${oldestMinutes}m ago; the 24h cutoff closes them).`
    );
  }
}

// --- The scan itself ---

/** Just enough of a ledger entry to re-verify its payment. */
type RecoverableEntry = Pick<
  LedgerEntry,
  'job_id' | 'customer_id' | 'created_at' | 'payment_signature' | 'payment_request'
>;

/**
 * Settlement binding and payment re-verification for the flat paid path.
 *
 * Holds no mutable state of its own: the ledger is the durable record and
 * {@link RecoveryDeferrals} is the backoff bookkeeping.
 */
export class PaymentRecovery {
  /**
   * Whether the RPC endpoint has earned the right to end a paying customer's
   * job. Process-wide and cached, because it is a property of the URL this
   * process was started with, not of any one scan.
   *
   * Only the two STABLE answers are cached. `wrong-cluster` cannot change
   * without a restart, and `sound` is not worth re-proving on every verdict.
   * Everything else (an unreachable endpoint, a throttled probe, a node that
   * refuses address history) stays `unchecked` and is re-probed next tick: an
   * endpoint that is merely down must not be condemned permanently, and one
   * that never answers simply never unlocks the verdict.
   */
  private endpointSoundness: 'unchecked' | 'sound' | 'wrong-cluster' = 'unchecked';
  /**
   * The probe currently in flight, so several entries reaching a verdict on the
   * same tick share ONE pair of RPC calls instead of each making its own before
   * the first has had a chance to cache its answer.
   */
  private endpointProbe: Promise<boolean> | undefined;
  /** Reason tags already shouted about, so the loud line is loud exactly once each. */
  private readonly warnedEndpointReasons = new Set<string>();

  constructor(
    private readonly ledger: JobLedger,
    private readonly network: Network,
    private readonly fetchProtocolConfig: () => Promise<ProtocolConfigInput>,
    private readonly strategy: PaymentStrategy,
  ) {}

  /** Shout about an endpoint we will not end jobs on - once per distinct reason. */
  private warnUntrustedEndpoint(reason: string, log: (msg: string) => void, detail: string): void {
    if (this.warnedEndpointReasons.has(reason)) {
      return;
    }
    this.warnedEndpointReasons.add(reason);
    log(
      `  ! WARNING: the Solana RPC endpoint cannot be trusted to decide that a customer did not ` +
        `pay: ${detail} Paid jobs whose payment cannot be found will NOT be closed as unpaid - ` +
        `they stay recoverable until the 24h cutoff and then fail as "the agent did not recover". ` +
        `Check SOLANA_RPC_URL and that it serves the ${this.network} cluster with transaction ` +
        `history enabled.`,
    );
  }

  /**
   * Whether this endpoint may be believed when it says a reference is empty.
   *
   * The terminal no-payment verdict is the one place the provider tells a paying
   * customer their money bought nothing, and every input to it comes from a
   * single RPC client named by an environment variable nothing checks. Two
   * consecutive empty listings from the WRONG CLUSTER, or from a node that does
   * not serve address history at all, are two copies of the same meaningless
   * answer - and would fail every paying customer of that agent.
   *
   * So before the verdict is allowed at all: the endpoint must report the
   * genesis hash of the cluster this agent is configured for, and must answer a
   * `getSignaturesForAddress` query. Neither costs anything after the first
   * success - the answer is cached for the process.
   *
   * Fails SAFE: anything short of both checks passing means "keep deferring",
   * which ends at the 24h cutoff as "the agent did not recover" rather than as a
   * false accusation. An operator running against a local validator (whose
   * genesis is its own) therefore never gets the fast verdict; that is the
   * intended trade.
   */
  private endpointMayIssueTerminalVerdict(
    rpc: Rpc<SolanaRpcApi>,
    log: (msg: string) => void,
  ): Promise<boolean> {
    if (this.endpointSoundness === 'sound') {
      return Promise.resolve(true);
    }
    if (this.endpointSoundness === 'wrong-cluster') {
      return Promise.resolve(false);
    }
    if (this.endpointProbe === undefined) {
      // Fill the single-flight slot BEFORE arranging to clear it. An `async`
      // method runs synchronously up to its first `await`, so a transport that
      // throws on the spot settles the whole probe - `finally` included - before
      // this assignment ever happens. Clearing from inside the method would then
      // wipe a slot that was still empty and leave the resolved `false` pinned
      // there for the life of the process: `endpointSoundness` stays
      // `unchecked`, every later probe returns that stale `false`, and the agent
      // can never close an unpaid job again.
      const probe = this.probeEndpointSoundness(rpc, log);
      this.endpointProbe = probe;
      const release = (): void => {
        // Only ever release OUR OWN flight, never a newer one.
        if (this.endpointProbe === probe) {
          this.endpointProbe = undefined;
        }
      };
      // Both arms, and the result deliberately dropped: `probe` itself is what
      // callers await, so attaching a handler here must not turn a rejection
      // into an unhandled one on a second, derived promise.
      void probe.then(release, release);
    }
    return this.endpointProbe;
  }

  /** The two RPC calls behind {@link endpointMayIssueTerminalVerdict}. */
  private async probeEndpointSoundness(
    rpc: Rpc<SolanaRpcApi>,
    log: (msg: string) => void,
  ): Promise<boolean> {
    try {
      const expectedGenesisHash = CLUSTER_GENESIS_HASHES[this.network];
      let genesisHash: string;
      try {
        genesisHash = await rpc.getGenesisHash().send();
      } catch (e: any) {
        this.warnUntrustedEndpoint(
          'unreachable',
          log,
          `it did not answer getGenesisHash (${e?.message ?? 'unknown error'}).`,
        );
        return false;
      }
      if (genesisHash !== expectedGenesisHash) {
        this.endpointSoundness = 'wrong-cluster';
        this.warnUntrustedEndpoint(
          'wrong-cluster',
          log,
          `it reports genesis ${genesisHash}, but this agent is configured for ${this.network}, ` +
            `whose genesis is ${expectedGenesisHash}.`,
        );
        return false;
      }
      try {
        await rpc
          .getSignaturesForAddress(asAddress(ADDRESS_HISTORY_PROBE_ADDRESS), {
            limit: 1,
            commitment: 'confirmed',
          })
          .send();
      } catch (e: any) {
        this.warnUntrustedEndpoint(
          'no-history',
          log,
          `it is on the right cluster but did not answer an address-history query ` +
            `(${e?.message ?? 'unknown error'}).`,
        );
        return false;
      }
      this.endpointSoundness = 'sound';
      return true;
    } catch (e: any) {
      // Defensive: every RPC call above is already wrapped, so reaching here
      // means something unexpected threw (a logger, say). Fail SAFE like the
      // handled paths, and leave `endpointSoundness` unchecked so the next
      // verdict re-probes. The single-flight slot is released by the caller.
      this.warnUntrustedEndpoint(
        'unreachable',
        log,
        `the endpoint check itself failed (${e?.message ?? 'unknown error'}).`,
      );
      return false;
    }
  }

  /**
   * Bind a verified settlement signature to this job, exactly once - see
   * `JobLedger.claimPaymentSignature`. Anything but `claimed` means the job is
   * NOT paid here and now; none of the three refusals is on its own evidence
   * that the customer failed to pay. Diagnostics log the FULL signature, both
   * job ids and the customer pubkey - all public values, and an operator
   * chasing a disputed payment should not have to match truncated prefixes.
   */
  claimSettlementSignature(
    txSignature: string,
    job: { jobId: string; customerId: string },
    log: (msg: string) => void,
  ): PaymentSignatureClaim {
    const owner = this.ledger.paymentSignatureOwner(txSignature);
    const outcome = this.ledger.claimPaymentSignature(txSignature, job.jobId);
    if (outcome === 'consumed-by-other') {
      log(
        `[${job.jobId.slice(0, 8)}] REFUSED: settlement ${txSignature} was already consumed by ` +
          `job ${owner ?? 'unknown'}. One transaction settles one job, so it is not attributable ` +
          `to job ${job.jobId} (customer ${job.customerId}).`,
      );
    } else if (outcome === 'not-persisted') {
      log(
        `[${job.jobId.slice(0, 8)}] REFUSED: could not WRITE the claim on settlement ` +
          `${txSignature} for job ${job.jobId} (customer ${job.customerId}) - refusing the ` +
          `payment rather than risk delivering twice for one transfer. Check disk space and ` +
          `permissions at the agent directory; the job retries on the next recovery tick.`,
      );
    } else if (outcome === 'unknown-job') {
      log(
        `[${job.jobId.slice(0, 8)}] REFUSED: job ${job.jobId} (customer ${job.customerId}) has ` +
          `no ledger entry, so the claim on settlement ${txSignature} has nowhere durable to ` +
          `live. This is a provider bug, not a disk problem - every paid job is recorded before ` +
          `payment collection. Report it with this log line.`,
      );
    }
    return outcome;
  }

  /**
   * List the transactions that could possibly be a payment for this request:
   * one `getSignaturesForAddress` window against the reference key, newest
   * first, minus the transactions that FAILED on chain. A failed transaction
   * moved no money, so it is neither a payment nor evidence that anyone touched
   * this reference - counting it would let ~5000 lamports of deliberately
   * failing transaction (or an honest customer whose transfer simply failed)
   * turn a job that should close in a minute into a 24h wait.
   *
   * Listed at `confirmed`, the level the SDK verifier reads transactions at.
   * The RPC default `finalized` would hide a confirmed-but-not-yet-finalized
   * payment from the one check that decides whether anything is there.
   *
   * RETRIED (`REFERENCE_SCAN_LIST_ATTEMPTS`): the terminal "nobody paid" verdict
   * rests entirely on this one call, and the public RPC is known to throttle and
   * lag this exact index. A single un-retried shot deciding whether a customer
   * loses their money is not a trade worth making; a false deferral costs
   * latency, a false "unpaid" destroys money. Retrying stops at the scan
   * `deadline`: past it the scan is going to return inconclusive anyway, and
   * the attempts left would only hold a shared slot.
   *
   * `windowFull` reports whether the RAW listing came back at the window size.
   * A full window means the history is TRUNCATED - a payment can be hiding
   * behind the newer transactions - so the caller must not read "nothing
   * verified" as "nobody paid". Measured before the failed-transaction filter,
   * because the limit applies to the raw page.
   *
   * An error is never "the customer did not pay" - the caller keeps the job
   * recoverable.
   */
  private async listReferenceCandidates(
    reference: Address,
    rpc: Rpc<SolanaRpcApi>,
    pastDeadline: () => boolean,
  ): Promise<{ signatures: string[]; windowFull: boolean } | { error: string }> {
    let lastMessage = 'unknown error';
    let attempts = 0;
    for (let attempt = 0; attempt < REFERENCE_SCAN_LIST_ATTEMPTS; attempt++) {
      attempts = attempt + 1;
      try {
        const listed = await rpc
          .getSignaturesForAddress(reference, {
            limit: REFERENCE_SCAN_WINDOW,
            commitment: 'confirmed',
          })
          .send();
        return {
          signatures: listed
            .filter((candidate) => !candidate.err)
            .map((candidate) => candidate.signature),
          windowFull: listed.length >= REFERENCE_SCAN_WINDOW,
        };
      } catch (e: any) {
        lastMessage = e?.message ?? 'unknown error';
        if (pastDeadline()) {
          break;
        }
        if (attempt < REFERENCE_SCAN_LIST_ATTEMPTS - 1) {
          await waitMs(REFERENCE_SCAN_LIST_RETRY_DELAY_MS);
        }
      }
    }
    return {
      error:
        `could not reach the chain to list the reference after ${attempts} of ` +
        `${REFERENCE_SCAN_LIST_ATTEMPTS} attempts: ${lastMessage}`,
    };
  }

  /**
   * Provider-side reference scan: list the reference's transactions and verify
   * the first one this job may actually own.
   *
   * The SDK's own reference path returns the newest VERIFYING transaction in
   * its window and cannot be asked for the next one. Fine for a customer
   * confirming their own payment; fatal for a provider, because a stranger who
   * attaches this job's reference to their own newer transfer makes the genuine
   * payment invisible to that path and the job dies at the 24h cutoff with the
   * money already taken. Walking the window and skipping the signatures the
   * ledger gave to OTHER jobs - which only the provider can know - is what
   * reaches such a payment.
   *
   * EXACTLY WHAT THAT RECOVERS, and no more: a payment masked by transactions
   * THIS ledger has already consumed, lying INSIDE one window. A mask built from
   * transactions the ledger knows nothing about is not skipped, only walked past
   * (each is fetched and rejected, which makes the scan inconclusive rather than
   * terminal); and a mask longer than the window pushes the payment off the page
   * entirely, where nothing here can see it. Both of those stay recoverable
   * until the 24h cutoff rather than being wrongly closed, which is the property
   * that actually protects the customer's money.
   *
   * BUDGET: `REFERENCE_SCAN_VERIFY_RETRIES` per candidate and the caller's
   * `deadline` for the whole scan, after which it returns inconclusive. Without
   * both, a rate-limited RPC holds a `p-limit` slot shared with live intake for
   * the SDK default of 10 retries x 3s x a full window - over ten minutes for
   * one deferred entry.
   *
   * TERMINAL ("none") REQUIRES ALL FOUR OF THESE, and the caller adds four more
   * on top (they are counted as six in the docs, where 2-4 below are read as one
   * condition - "nothing was skipped and nothing was left unverified"):
   *   1. the listing SUCCEEDED and came back SHORT of the window, so this is the
   *      reference's whole history rather than a truncated page. A flood that
   *      fills the window could be hiding the payment behind it, which is
   *      exactly how an attacker would manufacture a "nobody paid" verdict;
   *   2. NO candidate failed to verify. A candidate that did not verify is not
   *      evidence: the SDK reports "this is not a payment for this request" and
   *      "I could not reach the chain for this transaction" as the same
   *      `{verified: false, error}`, and an unreachable RPC must never be
   *      evidence of non-payment;
   *   3. no candidate was SKIPPED for belonging to another job. A skip means
   *      something did touch this reference and we chose not to look at it, so
   *      the scan saw less than the whole truth;
   *   4. no candidate was SKIPPED for an unusable signature. Same reasoning as
   *      3, with the node rather than the ledger as the reason we did not look:
   *      a blanked signature is still a transaction on this reference.
   * The caller then requires, in this order: that the job owns no settlement of
   * its own, that the payment request's own expiry has passed, that the endpoint
   * proved its cluster and that it serves address history, and - one level up,
   * in `runtime.ts` - a second consecutive sighting. Anything else is
   * inconclusive: a false deferral costs latency, a false "unpaid" destroys the
   * customer's money.
   *
   * What "none" therefore means is narrow and honest: after the failed-on-chain
   * transactions are dropped, the reference's entire history is EMPTY - there
   * was nothing at all to look at.
   */
  private async verifyByReferenceScan(
    reference: Address,
    rpc: Rpc<SolanaRpcApi>,
    jobId: string,
    pastDeadline: () => boolean,
    verifySignature: (txSignature: string, retries: number) => Promise<VerifyResult>,
  ): Promise<ReferenceScan> {
    // Before the listing as well: a pass the caller has already abandoned, or
    // one whose budget went on the steps before this, must not spend a shared
    // slot on an RPC call whose answer it may not use.
    if (pastDeadline()) {
      return { outcome: 'inconclusive', error: 'the reference scan ran out of time' };
    }
    const listed = await this.listReferenceCandidates(reference, rpc, pastDeadline);
    if ('error' in listed) {
      return { outcome: 'inconclusive', error: listed.error };
    }
    // The window is ALWAYS walked, full or not - a genuine payment inside a
    // flood must still be found. `windowFull` only disqualifies the verdict at
    // the bottom.
    let skippedConsumed = false;
    let skippedUnusable = false;
    let unverifiableCandidate: string | undefined;
    for (const candidate of listed.signatures) {
      if (pastDeadline()) {
        return { outcome: 'inconclusive', error: 'the reference scan ran out of time' };
      }
      if (!isUsableSignature(candidate)) {
        // Signatures arrive raw from the node's answer, and a broken or
        // rewriting proxy can blank one. Verifying it takes the same falsy
        // dispatch into the reference path, and the `verified` return below
        // would then hand the blank back as the settlement to claim. Skipping
        // is not enough on its own - see `skippedUnusable` at the bottom.
        skippedUnusable = true;
        continue;
      }
      const owner = this.ledger.paymentSignatureOwner(candidate);
      if (owner !== undefined && owner !== jobId) {
        skippedConsumed = true;
        continue; // already settled another job - look past it
      }
      const verified = await verifySignature(candidate, REFERENCE_SCAN_VERIFY_RETRIES);
      if (verified.verified) {
        // The settlement is the transaction we just asked about, never whatever
        // the strategy chose to echo back - the de-duplication claim must not
        // be redirectable by a buggy or hostile strategy implementation.
        return { outcome: 'verified', txSignature: candidate };
      }
      unverifiableCandidate ??= verified.error ?? 'no reason given';
    }
    // Checked again HERE, and not only inside the loop above: an empty page
    // means that loop never runs, so a listing that took longer than the whole
    // budget would otherwise fall straight through to `none` - and on this rail
    // `none` is what closes a paying customer's job. `listReferenceCandidates`
    // reads the clock only in its `catch`, so a slow but SUCCESSFUL call never
    // sees the deadline at all.
    if (pastDeadline()) {
      return { outcome: 'inconclusive', error: 'the reference scan ran out of time' };
    }
    if (listed.windowFull) {
      return {
        outcome: 'inconclusive',
        error:
          `the reference carries at least ${REFERENCE_SCAN_WINDOW} transactions, so its history ` +
          `is truncated and a payment could be hidden behind the flood`,
      };
    }
    if (skippedConsumed) {
      return {
        outcome: 'inconclusive',
        error:
          'the reference carries a transaction another job already settled, so this scan did ' +
          'not see the whole picture',
      };
    }
    if (skippedUnusable) {
      return {
        outcome: 'inconclusive',
        error:
          'the reference carries a transaction whose signature the node reported unusably, so ' +
          'this scan did not see the whole picture',
      };
    }
    if (unverifiableCandidate !== undefined) {
      // Distinct wording on purpose: the operator needs to be able to tell
      // "somebody is putting junk on this reference" apart from "our RPC is
      // down", which produce the same volume of log lines. Both are
      // inconclusive, because the SDK reports them identically.
      return {
        outcome: 'inconclusive',
        error:
          `the reference carries a transaction that did not verify as a payment for this job ` +
          `(${unverifiableCandidate}) - indistinguishable, in what the verifier reports, from one ` +
          `we simply failed to read`,
      };
    }
    return { outcome: 'none' };
  }

  /**
   * Re-verify an on-chain payment during crash recovery.
   *
   * Two outcomes are terminal, and they mean opposite things. `corrupt-state` is
   * OUR state being unusable - no amount of waiting repairs it, so the caller
   * closes the job at once rather than hold it for 24h. `no-payment` is a scan
   * that saw the reference's WHOLE history and found nothing capable of being a
   * payment; even that only fails the job once the request's own expiry has
   * passed AND on a second consecutive sighting (the caller's check), because
   * one empty listing from a throttling RPC is not worth a customer's money.
   * Everything else defers: recovery cannot tell a non-paying customer apart
   * from a shutdown abort, a flaky RPC, or a stranger's transaction carrying
   * this job's (publicly readable) reference. The 24h `MAX_PAID_AGE_MS` cutoff
   * bounds the wait and closes the job as "the agent did not recover", never as
   * a false "the customer did not pay".
   *
   * Evidence order matters: a job that already CLAIMED a settlement is
   * re-verified against that exact signature first, and an empty scan can never
   * outrank it - the ledger is better evidence than an RPC that has aged the
   * transaction out of its history window.
   *
   * Limitation: Solana transaction data expires after ~2-3 days (recent blockhash
   * window). If the agent was down longer, a confirmed payment may not be found
   * on-chain. For mainnet: use monitoring, avoid extended downtime, or configure
   * an archive RPC via SOLANA_RPC_URL.
   */
  async reVerifyPayment(
    entry: RecoverableEntry,
    paymentRequestJson: string,
    priceSubunits: number,
    log: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<PaymentReVerification> {
    const shortId = entry.job_id.slice(0, 8);
    // OUR OWN STATE, validated before anything transient can be blamed for it.
    // A `payment_request` that is not JSON, or whose reference is not an
    // address, can never verify - deferring it only burns a 24h slot and buries
    // the real problem under a day of "could not confirm" lines.
    let request: PaymentRequestData;
    let reference: Address;
    try {
      request = JSON.parse(paymentRequestJson);
      reference = asAddress(request.reference);
    } catch (e: any) {
      log(
        `[${shortId}] Recovery: the persisted payment request is unusable (${e?.message ?? 'unknown error'}) - ` +
          `this is provider-side state, not a chain or customer problem.`,
      );
      return 'corrupt-state';
    }
    let deadline: number;
    try {
      const rpc = createSolanaRpc(getRpcUrl(this.network));
      const protocolConfig = await this.fetchProtocolConfig();
      // The whole re-verification, the job's own settlement included, is bounded
      // by one deadline. Left outside it, a claimed settlement that has aged out
      // of RPC history costs a full retry budget of a shared `p-limit` slot on
      // every single tick, before the scan it is supposed to precede even starts.
      //
      // Started AFTER the config read, which is an on-chain fetch of its own and
      // refreshes on every tick: counting it against the scan's budget meant a
      // slow config could spend the whole allowance before the scan began, and
      // the scan would then answer as though it had looked.
      deadline = Date.now() + REFERENCE_SCAN_DEADLINE_MS;
      // Reads the SIGNAL as well as the clock, exactly as the acceptor's does.
      // The signal used to reach the scan only through the `verify` closure -
      // which an EMPTY listing never calls, so a pass the operator had already
      // stopped could still walk out with `no-payment` and fail a paid job on
      // the way down. One policy on both rails, or neither rail has one.
      const pastDeadline = () => signal?.aborted === true || Date.now() >= deadline;

      // After the config, because the treasury comes from it and a reference
      // equal to the treasury drowns the payment in its history whether or not
      // the request names it.
      //
      // Computed unconditionally, GATED on action - the same shape the acceptor
      // uses. Gating the check itself would leave a job that owns a settlement
      // walking into the scan and listing a degenerate reference: for one equal
      // to the recipient that lists the provider's own wallet, which is always
      // full, so the operator is told "its history is truncated and a payment
      // could be hidden behind the flood" about their own address - the exact
      // misdirection this check exists to remove.
      //
      // The carve-out itself is NOT "such a job can re-verify its own
      // signature" - it cannot: the denylist inside `verifyPayment` sits ahead
      // of both branches. It is that the denylist GROWS between releases, and
      // the condition matches that scenario exactly rather than approximately:
      // to own a `payment_signature` at all, the job must once have passed
      // `verifyPayment`, which refuses a degenerate reference - so "owns a
      // settlement AND the reference reads degenerate now" can only mean the
      // list grew since. A deferral is recoverable by rolling the SDK back
      // inside the window; a terminal verdict is recoverable by nothing.
      //
      // `ProviderPaymentAcceptor` carves the same exception, for this reason;
      // the two rails must not answer this differently.
      const degenerate = await degenerateReference(request, this.network, protocolConfig.treasury);
      if (degenerate !== undefined) {
        if (!isUsableSignature(entry.payment_signature)) {
          log(
            `[${shortId}] Recovery: the payment request's reference (${request.reference}) is an ` +
              `address the payment itself is computed from, so the transfer cannot be singled ` +
              `out by listing it. This is provider-side state, not a chain or customer problem.`,
          );
          return 'corrupt-state';
        }
        log(
          `[${shortId}] Recovery: the reference (${request.reference}) is an address the payment ` +
            `is computed from, but this job already owns settlement ${entry.payment_signature} - ` +
            `deferring rather than failing it, in case this build's list grew past what the ` +
            `settlement was accepted under. Not listing the reference: it cannot single out a ` +
            `payment.`,
        );
        return 'deferred';
      }

      /**
       * `retries` is the per-verification budget: `REFERENCE_SCAN_VERIFY_RETRIES`
       * for a scan candidate, `OWN_SETTLEMENT_VERIFY_RETRIES` for the one
       * signature this job already owns (a known payment, worth more - but not
       * the SDK default, which is 30s of a shared slot per tick).
       */
      const verify = async (txSignature: string, retries: number): Promise<VerifyResult> => {
        const verification = this.strategy.verifyPayment(rpc, request, protocolConfig, {
          txSignature,
          retries,
        });
        if (!signal) {
          return verification;
        }
        let abortHandler: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) {
            abortHandler();
            return;
          }
          signal.addEventListener('abort', abortHandler, { once: true });
        });
        try {
          return await Promise.race([verification, abortPromise]);
        } finally {
          if (abortHandler) {
            signal.removeEventListener('abort', abortHandler);
          }
        }
      };

      // Own evidence first - see the evidence-order note above.
      const ownSignature = entry.payment_signature;
      let txSignature: string | undefined;
      // Not `!== undefined`: an empty string is what a hand-edited ledger
      // carries, and it passes that test while owning nothing. Re-verifying it
      // sends `{ txSignature: '' }` into the strategy, whose falsy dispatch
      // routes to the REFERENCE path, returns the first transaction carrying
      // this reference - a stranger's, if one is there - and claims the empty
      // string over it, leaving the real signature free for the next job.
      if (isUsableSignature(ownSignature) && !pastDeadline()) {
        const own = await verify(ownSignature, OWN_SETTLEMENT_VERIFY_RETRIES);
        if (own.verified) {
          txSignature = ownSignature;
        } else {
          log(
            `[${shortId}] Recovery: the settlement this job already claimed (${ownSignature}) no ` +
              `longer verifies (${own.error ?? 'unknown'}); falling back to the reference scan.`,
          );
        }
      }

      if (txSignature === undefined) {
        const scan = await this.verifyByReferenceScan(
          reference,
          rpc,
          entry.job_id,
          pastDeadline,
          verify,
        );
        if (scan.outcome === 'none') {
          // The same predicate as the gate above, not `!== undefined`: an empty
          // string means this job owns NOTHING, and reading it as ownership
          // here would log a sentence naming no settlement at all and hold the
          // entry to the 24h cutoff instead of letting the verdict land.
          if (isUsableSignature(ownSignature)) {
            // The ledger says this job owns a settlement; an RPC that no longer
            // lists it has aged past its history horizon, which is not evidence
            // of non-payment. Never force-fail a job we recorded as paid.
            log(
              `[${shortId}] Recovery: the reference scan is empty, but this job already owns ` +
                `settlement ${ownSignature} - treating the empty scan as an RPC history gap, ` +
                `not as non-payment. Deferring.`,
            );
            return 'deferred';
          }
          const notBefore = terminalVerdictNotBefore(request, entry.created_at);
          if (Date.now() < notBefore) {
            // The customer is still inside the window this very provider
            // advertised. An empty reference proves nothing yet: a wallet
            // confirmation two minutes into a ten-minute window is an ordinary
            // customer, not an abandoned job.
            const secondsLeft = Math.ceil((notBefore - Date.now()) / 1000);
            log(
              `[${shortId}] Recovery: the reference is still empty, but the payment request this ` +
                `provider issued does not expire for another ${secondsLeft}s - a customer is ` +
                `entitled to the whole window. Waiting out the window.`,
            );
            return 'awaiting-window';
          }
          // LAST gate, and the only one that is about US rather than the chain:
          // every input above came from one RPC client named by an unchecked
          // environment variable. An endpoint on the wrong cluster, or one that
          // does not serve address history, answers "empty" for every reference
          // there is - and would fail every paying customer of this agent.
          if (!(await this.endpointMayIssueTerminalVerdict(rpc, log))) {
            log(
              `[${shortId}] Recovery: the reference scan is empty, but this RPC endpoint has not ` +
                `proved it is the ${this.network} cluster and serves address history - refusing ` +
                `to call that non-payment. Deferring.`,
            );
            return 'deferred';
          }
          log(
            `[${shortId}] Recovery: a complete scan of this reference, after the payment ` +
              `request expired, found no payment for this job.`,
          );
          return 'no-payment';
        }
        if (scan.outcome === 'inconclusive') {
          log(
            `[${shortId}] Recovery: payment could not be confirmed (${scan.error}); ` +
              `deferring to the next tick.`,
          );
          return 'deferred';
        }
        txSignature = scan.txSignature;
      }

      const claim = this.claimSettlementSignature(
        txSignature,
        { jobId: entry.job_id, customerId: entry.customer_id },
        log,
      );
      if (claim !== 'claimed') {
        log(
          `[${shortId}] Recovery: ${claimRefusalSentence(claim)}; deferring. The job stays paid ` +
            `and the next tick looks again.`,
        );
        return 'deferred';
      }
      const fee = calculateProtocolFee(priceSubunits, protocolConfig.feeBps);
      const netAmount = priceSubunits - fee;
      // `payment_request` is exactly the value this call was handed - re-writing
      // it would only be a no-op with a chance of clobbering a newer one.
      this.ledger.updatePayment(entry.job_id, netAmount);
      log(`[${shortId}] Recovery: payment re-verified (${netAmount} subunits)`);
      return 'verified';
    } catch (e: any) {
      log(`[${shortId}] Recovery: payment re-verification error: ${e.message}; deferring.`);
      return 'deferred';
    }
  }
}

/**
 * Wall-clock before which no empty scan may close this job: the expiry of the
 * payment request THIS PROVIDER issued (`created_at + expiry_secs`).
 *
 * Without it the terminal verdict can land long before the customer's own
 * deadline. The live verify race resolves as soon as both of its one-shot paths
 * have lost - seconds, not the advertised window - and two recovery ticks later
 * an empty reference would close a request that still had eight minutes to run.
 * A customer who confirms in their wallet at two minutes would be failed before
 * their payment could even be expected, with the money already sent.
 *
 * Either timestamp being unusable (a hand-edited ledger, a request written by a
 * build that predates the field) falls back to the job's own acceptance time
 * and the SDK's default window - the values such a request was almost certainly
 * issued with, and within seconds of each other in any real provider. The
 * fallback always extends the wait: "we cannot tell when this expired" must
 * never resolve to "it has expired".
 */
function terminalVerdictNotBefore(request: PaymentRequestData, entryCreatedAt: number): number {
  const requestCreatedAt = Number(request.created_at);
  const expirySecs = Number(request.expiry_secs);
  const createdAt =
    Number.isFinite(requestCreatedAt) && requestCreatedAt > 0 ? requestCreatedAt : entryCreatedAt;
  const window =
    Number.isFinite(expirySecs) && expirySecs > 0 ? expirySecs : DEFAULTS.PAYMENT_EXPIRY_SECS;
  return (createdAt + window) * 1000;
}
