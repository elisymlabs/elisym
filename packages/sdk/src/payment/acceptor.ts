import { type Rpc, type SolanaRpcApi, address, isAddress } from '@solana/kit';
import { DEFAULTS } from '../constants';
import type { PaymentRequestData, VerifyResult } from '../types';
import { resolveAssetFromPaymentRequest } from './assets';
import { degenerateReference } from './degenerate-reference';
import { calculateProtocolFee } from './fee';
import type { PaymentStrategy, ProtocolConfigInput } from './strategy';

/** Outcome of asking a store to bind one settlement to one job. */
export type SettlementClaim = 'claimed' | 'consumed-by-other' | 'not-persisted';

/**
 * A signature a settlement claim can be keyed on.
 *
 * `@elisym/cli` carries a second copy in its own ledger, deliberately: this one
 * is not part of the package's public API, so the CLI cannot import it. The two
 * are kept identical by hand, and they have to be - a gate spelled `!== undefined`
 * on one side of that line lets an empty string through where the other refuses.
 *
 * Written once per package and read everywhere rather than spelled out at each gate,
 * because the gates have to agree: two differing by an `=== undefined` is how
 * an empty string gets through one and not the next. An empty string owns
 * nothing - the index drops it - so a claim keyed on one leaves the
 * transaction free for the next job while this one is marked paid.
 */
export function isUsableSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Floor on how long a settlement record has to be kept.
 *
 * Declared beside the interface rather than beside the file-backed store,
 * because every store owes it - a browser one included, and that cannot import
 * `./node`. The reasoning is the chain's history horizon: a signature dropped
 * from the index has to be unverifiable on-chain by then, or it settles a
 * second job. A public RPC keeps ~2-3 days; thirty is a tenfold margin,
 * because archival providers keep more and "unverifiable" is therefore not
 * strictly guaranteed at all. The margin compensates for that - it does not
 * prove it.
 */
export const MIN_SETTLEMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SettlementStore {
  /**
   * SYNCHRONOUSLY, and in one unbroken turn of the event loop: read the index
   * and write to it. Returning `claimed` means the record is ALREADY on disk.
   * A store that writes asynchronously (a database, a KV, IndexedDB) cannot
   * meet this contract.
   *
   * Re-claiming by the SAME job always succeeds - step 1 stands on that. A
   * third-party store answering `consumed-by-other` to a job's own signature
   * breaks it.
   *
   * The signature must be a non-empty string; an unusable one is rejected by
   * throwing, symmetrically with `jobIdentity`. (The predicate this package
   * uses internally is not exported - implement the shape, not the import.)
   * This is not a duplicate of the step-5 guard but its other half, made
   * observable: a single mutation dropping
   * the usability test inside the acceptor is unobservable there, because three
   * earlier gates keep an unusable signature away from step 5. A provider
   * bringing their own store has no other protection at all.
   */
  claim(signature: string, jobIdentity: string): SettlementClaim;
  /** Reads the file, like every operation here: no in-memory state. */
  owner(signature: string): string | undefined;
  /**
   * The job's own proof of work done. Never names a signature whose claim did
   * not reach disk, and only the one the forward index attributes to this job
   * RIGHT NOW - the rule "`not-persisted` at step 1 is an accept" stands on
   * that.
   *
   * Returns what the forward index attributes, INCLUDING an empty string: the
   * file-backed implementation does not filter those, and `accept` is what has
   * to. Promising "only non-empty" here would make the fixture that seeds one
   * vacuous. A conforming implementation never creates one; they arrive by
   * hand-editing the file, or from a third-party store.
   */
  claimedSignature(jobIdentity: string): string | undefined;
  /**
   * Drop settlements older than `retentionMs`. Reads the file and writes by
   * what it RE-READ: writing by its own snapshot erases a claim made after it.
   * Writes nothing at all when it deletes nothing. A retention below
   * {@link MIN_SETTLEMENT_RETENTION_MS} is rejected by throwing.
   *
   * Unlike `claim`, a write that fails here THROWS rather than being reported:
   * a prune that could not persist has released nothing, and the caller is a
   * scheduled sweep rather than a payment.
   */
  prune(retentionMs: number): number;
}

export interface AcceptPaymentInput {
  paymentRequest: PaymentRequestData;
  /**
   * A non-empty string, UNIQUE per job and STABLE across restarts. Both
   * `accept` and the store validate it, but only for emptiness - uniqueness is
   * not checkable. A provider deriving it from something stable but SHARED -
   * the customer's pubkey, the request's reference, a skill name - closes
   * several jobs with one signature through step 1, bypassing de-duplication.
   */
  jobIdentity: string;
  /**
   * If given, must be a non-empty string; an unusable one is rejected by
   * throwing. `verifyPayment` dispatches on `if (options?.txSignature)`, and
   * both `''` and `null` are falsy there - the call would take the REFERENCE
   * path and come back with somebody else's signature, which step 5 may not
   * claim.
   */
  txSignature?: string;
  /**
   * Checked wherever the deadline is, and with the same effect: the pass
   * reports `inconclusive`, never `window-empty` - an abandoned look has seen
   * less than the whole window, so it must not produce the one verdict a
   * provider may act on. The two are the same test, so neither can drift ahead
   * of the other.
   *
   * What it does NOT do is cut a call short. It is read at step boundaries and
   * once more before the verdict, so an abort during a verification still waits
   * out that verification's own retries; it is not plumbed into the strategy,
   * which has no way to take one.
   */
  signal?: AbortSignal;
  /**
   * Defaults apply through `??`, never `||`: zeros are meaningful here
   * (`intervalMs: 0`, `deadlineMs: 0`) and `||` would silently replace them.
   */
  budget?: {
    retriesPerCandidate?: number;
    retriesForOwnSettlement?: number;
    intervalMs?: number;
    listAttempts?: number;
    deadlineMs?: number;
  };
}

export type AcceptPaymentResult =
  | { accepted: true; txSignature: string }
  | {
      accepted: false;
      /**
       * `window-empty` is NOT the verdict "the customer did not pay".
       *
       * It says one thing: in this one pass the reference's window was read
       * whole and held no payment for this request. The CLI's terminal verdict
       * stands on six conditions, and this class supplies only three - a short
       * window rather than a truncated one, nothing skipped or left unverified,
       * and a job that owns no settlement of its own. The caller owes the other
       * three before closing a job on it:
       *
       *   - the payment request's OWN expiry has passed (`created_at +
       *     expiry_secs`); `accept` does not check it;
       *   - a SECOND CONSECUTIVE pass says the same, with real time between the
       *     two looks - two listings a minute apart against an index the RPC
       *     lags are not independent, and independence is why a second look is
       *     required at all;
       *   - the ENDPOINT has proven its cluster and that it keeps a history
       *     index; an empty answer from a node that indexes nothing is evidence
       *     of nothing.
       *
       * Until all three hold, treat it exactly as `inconclusive`.
       */
      reason:
        | 'window-empty'
        | 'inconclusive'
        | 'not-persisted'
        | 'degenerate_reference'
        | 'unusable-request';
      /**
       * Diagnostics, not contract: the last candidate's reason for
       * `inconclusive`, the disk's complaint for `not-persisted`. Absent for
       * `window-empty`, `degenerate_reference` and `unusable-request`. Do not
       * build logic on it - and do not relay it to the CUSTOMER: it can say
       * that a settlement is already bound to another job, which is a fact
       * about a stranger's payment that they have no business learning.
       */
      error?: string;
    };

const DEFAULT_RETRIES_PER_CANDIDATE = 3;
const DEFAULT_RETRIES_FOR_OWN_SETTLEMENT = 5;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LIST_ATTEMPTS = 3;
const DEFAULT_DEADLINE_MS = 30_000;
/** Pause between listing attempts. Deliberately not a knob - see the plan. */
const LIST_RETRY_PAUSE_MS = 400;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Can this request be paid AT ALL, or is it only unpayable against today's
 * config?
 *
 * A new function rather than an extraction out of `verifyPayment`: the address
 * FORMAT checks do not exist there (it tests presence only), and asset
 * resolution sits outside the range. "Extracting" would mean ADDING checks to
 * shared code, and `verifyPayment` would start refusing payments it accepts
 * today. This mirrors the preconditions and shares their constants instead; a
 * parity test runs one set of requests through both.
 *
 * Deliberately NOT public API - re-exporting it would add a sixth reason to the
 * version bump.
 */
export function classifyRequestUsability(
  request: PaymentRequestData,
  config: ProtocolConfigInput,
): 'unusable-request' | 'inconclusive' | undefined {
  // Presence first, in the falsy form the verifier uses literally: through
  // `=== undefined` a `reference: null` would throw inside `isAddress`, which
  // reads `.length`, instead of classifying.
  if (!request.reference || !request.recipient) {
    return 'unusable-request';
  }
  if (!isAddress(request.reference) || !isAddress(request.recipient)) {
    return 'unusable-request';
  }
  if (!Number.isInteger(request.amount) || request.amount <= 0) {
    return 'unusable-request';
  }
  if (
    request.fee_amount !== null &&
    request.fee_amount !== undefined &&
    (!Number.isInteger(request.fee_amount) || request.fee_amount < 0)
  ) {
    return 'unusable-request';
  }
  try {
    resolveAssetFromPaymentRequest(request);
  } catch {
    return 'unusable-request';
  }

  // Everything below depends on a fee rate that lives on-chain and changes
  // without a client release, so none of it is terminal: a request incompatible
  // with today's fee is polled until its own expiry rather than killed.
  //
  // `expectedFee` is computed INSIDE this gate and AFTER the amount mirror
  // above: `calculateProtocolFee` throws on a non-integer or negative amount,
  // and a negative or NaN `feeBps` must not make this predicate throw either.
  if (config.feeBps > 0) {
    const expectedFee = calculateProtocolFee(request.amount, config.feeBps);
    const feeAmount = request.fee_amount ?? 0;
    if (feeAmount < expectedFee) {
      return 'inconclusive';
    }
    // PROVABLY REDUNDANT for any real config, and kept as a mirror: the next
    // line answers the same for a missing address, because `undefined !==
    // config.treasury` - the two diverge only if the treasury were itself
    // undefined, which the type forbids and `accept` would have thrown on. It is
    // written out because this predicate mirrors `verifyPayment`'s preconditions
    // line by line (`solana.ts`), and a mirror with a line missing is a mirror
    // somebody has to re-derive. No mutation can kill it - measured.
    if (!request.fee_address) {
      return 'inconclusive';
    }
    if (request.fee_address !== config.treasury) {
      return 'inconclusive';
    }
  }
  return undefined;
}

/**
 * De-duplicating payment acceptance for providers who hold the SDK directly.
 *
 * `verifyPayment` answers "a transaction satisfying this request exists", which
 * is not "this transaction is mine to keep": one transfer can carry several
 * jobs' references. Binding a settlement to exactly one job is the caller's
 * duty, and until now only the CLI discharged it.
 */
export class ProviderPaymentAcceptor {
  constructor(
    private readonly deps: {
      strategy: PaymentStrategy;
      rpc: Rpc<SolanaRpcApi>;
      store: SettlementStore;
    },
  ) {}

  /**
   * One shot. Repeating until the request expires is the provider's duty, as is
   * the expiry itself - this does not check it. Two concurrent calls for one
   * `jobIdentity` are forbidden: "a second signature releases the first" makes
   * that unsafe.
   *
   * Throws on a malformed `jobIdentity`, `txSignature` or `feeBps`, and passes
   * through anything the injected store or strategy throws - the file-backed
   * store reads its index on every call, so an index it refuses to read surfaces
   * here rather than as a verdict.
   */
  async accept(
    input: AcceptPaymentInput,
    config: ProtocolConfigInput,
  ): Promise<AcceptPaymentResult> {
    const { paymentRequest, jobIdentity } = input;
    if (!isUsableSignature(jobIdentity)) {
      throw new Error('jobIdentity must be a non-empty string unique to this job');
    }
    if (input.txSignature !== undefined && !isUsableSignature(input.txSignature)) {
      throw new Error(
        'txSignature, when given, must be a non-empty string - an unusable one would send ' +
          'verification down the reference path and return a settlement this job may not claim',
      );
    }
    // Checked here rather than left to whichever call happens to touch it
    // first: `calculateProtocolFee` throws on a fractional rate while `NaN > 0`
    // is merely false, so without this the same request answers with a verdict
    // or with an exception depending on what the chain happens to hold.
    if (!Number.isInteger(config.feeBps) || config.feeBps < 0) {
      throw new Error(`feeBps must be a non-negative integer, got ${String(config.feeBps)}`);
    }

    const budget = input.budget ?? {};
    const retriesPerCandidate = budget.retriesPerCandidate ?? DEFAULT_RETRIES_PER_CANDIDATE;
    const retriesForOwn = budget.retriesForOwnSettlement ?? DEFAULT_RETRIES_FOR_OWN_SETTLEMENT;
    const intervalMs = budget.intervalMs ?? DEFAULT_INTERVAL_MS;
    const listAttempts = budget.listAttempts ?? DEFAULT_LIST_ATTEMPTS;
    const deadlineMs = budget.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const deadline = Date.now() + deadlineMs;

    /**
     * Stop early: the caller gave up, or the budget ran out.
     *
     * `>=`, not `>`. With `deadlineMs: 0` the two differ only in the single
     * millisecond where the clock EQUALS the deadline, and `>` leaves the
     * fixture that passes zero depending on whether any wall-clock time
     * happened to elapse first. No test pins that - pinning it would need
     * frozen clocks, and a frozen clock never lets the listing pause expire -
     * so it is a deliberate choice caught by diff review, made for determinism
     * rather than against an observable mutant.
     */
    const pastDeadline = () => input.signal?.aborted === true || Date.now() >= deadline;

    let imperfectPass = false;
    let deadlineHit = false;
    let lastError: string | undefined;

    // STEP 0 - before any network, and in this order. The usability predicate
    // runs first because it catches an unresolvable asset as `unusable-request`,
    // while the degenerate-reference check resolves the asset inside itself and
    // would throw on an unknown one. On ANY verdict from the predicate -
    // terminal or `inconclusive` - the reference check does not run at all.
    let stepZero: AcceptPaymentResult | undefined;
    const usability = classifyRequestUsability(paymentRequest, config);
    if (usability === 'unusable-request') {
      stepZero = { accepted: false, reason: 'unusable-request' };
    } else if (usability === 'inconclusive') {
      stepZero = { accepted: false, reason: 'inconclusive' };
    } else {
      const degenerate = await degenerateReference(
        paymentRequest,
        paymentRequest.network ?? 'devnet',
        config.treasury,
      );
      if (degenerate !== undefined) {
        stepZero = { accepted: false, reason: 'degenerate_reference' };
      }
    }

    // The carve-out: a job that already owns a settlement is NOT closed by a
    // step-0 verdict.
    //
    // What step 1 can then do differs by BRANCH, and the two were measured
    // rather than assumed:
    //
    //   degenerate_reference -> step 1 cannot accept either. `verifyPayment`
    //     runs the same degenerate-reference check ahead of both its branches,
    //     so it refuses too and the call ends `inconclusive`. The carve-out
    //     buys a recoverable verdict, nothing more.
    //   unusable-request -> step 1 is LIVE and can accept. The predicate reads
    //     the REQUEST; `verifyPayment` reads the CHAIN, and a settled job's own
    //     signature still verifies against a request this build calls unusable.
    //     The suite pins this: a settled job whose request our predicate
    //     rejects comes back `accepted: true` through step 1.
    //
    // The reason for both is that BOTH lists here grow in minor releases, so a
    // job paid and settled under an older build can be re-read as unpayable by
    // a newer one. `inconclusive` is recoverable - the provider keeps asking,
    // and an operator who rolls back gets the settlement verified under the
    // list it was accepted with. A terminal verdict is recoverable by nothing.
    //
    // `@elisym/cli` carves the same exception out of its own recovery pass for
    // the degenerate-reference half, for this same reason; the two rails must
    // not answer THAT differently. Its other terminal verdict - persisted state
    // it cannot parse at all - has no carve-out and needs none: that list does
    // not grow between releases, while both of these do.
    //
    // Read HERE rather than at step 1 when there is a verdict, because that is
    // where the answer is needed first; step 1 reuses it through
    // `ownSignatureRead`. It is one file read either way - this buys ordering,
    // not a saving.
    let ownSignature: string | undefined;
    let ownSignatureRead = false;
    if (stepZero !== undefined) {
      ownSignature = this.deps.store.claimedSignature(jobIdentity);
      ownSignatureRead = true;
      if (!isUsableSignature(ownSignature)) {
        return stepZero;
      }
    }
    const carvedOut = stepZero !== undefined;

    // STEP 1 - the job's own evidence, before anything a counterparty controls.
    // The deadline check sits here UNCONDITIONALLY and raises the flag even
    // when there is nothing for the step to do; read `claimedSignature` first,
    // because step 6 reuses the value.
    if (!ownSignatureRead) {
      ownSignature = this.deps.store.claimedSignature(jobIdentity);
    }
    if (pastDeadline()) {
      deadlineHit = true;
    }
    if (!deadlineHit && isUsableSignature(ownSignature)) {
      const verified = await this.verify(
        paymentRequest,
        config,
        ownSignature,
        retriesForOwn,
        intervalMs,
      );
      if (verified.verified) {
        const settled = this.settle(ownSignature, jobIdentity);
        if (settled.accepted) {
          return settled;
        }
        if (settled.reason === 'not-persisted') {
          // Step 1 only: the signature is already persistent and already owned
          // by this job, so the claim here refreshes a timestamp. A disk
          // refusal does not get to undo proven ownership.
          return { accepted: true, txSignature: ownSignature };
        }
        imperfectPass = true;
      } else {
        // Deliberately does NOT mark the pass imperfect - that is what keeps
        // the step-6 rule "`claimedSignature` is set -> inconclusive" from
        // being inert.
        lastError = verified.error ?? lastError;
      }
    }
    if (carvedOut) {
      // No listing on a request our own predicate rejects: by a degenerate
      // reference it is useless, by an unusable request it is meaningless.
      return { accepted: false, reason: 'inconclusive', error: lastError };
    }

    // STEP 2 - the signature the customer sent. The most counterparty-controlled
    // input there is, which is why it does not go first.
    if (pastDeadline()) {
      deadlineHit = true;
    }
    if (!deadlineHit && input.txSignature !== undefined) {
      const verified = await this.verify(
        paymentRequest,
        config,
        input.txSignature,
        retriesPerCandidate,
        intervalMs,
      );
      if (verified.verified) {
        const settled = this.settle(input.txSignature, jobIdentity);
        if (settled.accepted) {
          return settled;
        }
        if (settled.reason === 'not-persisted') {
          return settled;
        }
        imperfectPass = true;
      } else {
        // Marks the pass imperfect: the signature may simply not be indexed
        // yet, and without the mark the outcome would land on `window-empty`
        // where the customer paid a minute ago.
        imperfectPass = true;
        lastError = verified.error ?? lastError;
      }
    }

    // STEP 3 - the listing.
    let windowFull = false;
    let candidates: string[] = [];
    let listed = false;
    // NOT KILLED BY ANY TEST, and provably so: the first iteration of the loop
    // below re-reads the same predicate, so removing this line changes nothing
    // observable. It is kept because every step boundary in this function reads
    // the clock the same way, and a reader who finds one missing has to work
    // out whether it was an oversight.
    if (pastDeadline()) {
      deadlineHit = true;
    }
    if (!deadlineHit) {
      for (let attempt = 0; attempt < listAttempts; attempt++) {
        // The other half of the pair named above, and NOT KILLED ON ITS OWN
        // either: with the check before the loop in place, this one only ever
        // matters from the second attempt onwards, and the verdict is the same
        // whichever of the two fires. It stops a retried listing from running
        // on after the caller left; the pass is already inconclusive by then.
        if (pastDeadline()) {
          deadlineHit = true;
          break;
        }
        try {
          const page = (await this.deps.rpc
            .getSignaturesForAddress(address(paymentRequest.reference), {
              limit: DEFAULTS.VERIFY_SIGNATURE_LIMIT,
              commitment: 'confirmed',
            })
            .send()) as readonly { signature: string; err: unknown }[];
          // `windowFull` is counted on the RAW page, before failed transactions
          // are dropped.
          //
          // The filter itself is NOT KILLED BY ANY TEST: `SolanaPaymentStrategy`
          // refuses a transaction whose `meta.err` is set anyway, so dropping
          // it here only saves RPC round-trips and `imperfectPass` marks. It
          // stays because a third-party strategy owes no such check.
          windowFull = page.length >= DEFAULTS.VERIFY_SIGNATURE_LIMIT;
          candidates = page.filter((entry) => !entry.err).map((entry) => entry.signature);
          listed = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt < listAttempts - 1) {
            await waitMs(LIST_RETRY_PAUSE_MS);
          }
        }
      }
    }

    // STEP 4 - walk the candidates.
    if (listed) {
      for (const candidate of candidates) {
        if (pastDeadline()) {
          deadlineHit = true;
          break;
        }
        if (!isUsableSignature(candidate)) {
          // Unlike a failed transaction, this one was never LOOKED AT: it is an
          // untrusted node's answer, not a fact about the chain. Without the
          // mark a listing of `['']` in a short window produces an empty walk,
          // nothing marked, and `window-empty` - manufacturing the one verdict
          // a provider may call "nobody paid".
          imperfectPass = true;
          continue;
        }
        const owner = this.deps.store.owner(candidate);
        if (owner !== undefined && owner !== jobIdentity) {
          imperfectPass = true;
          continue;
        }
        const verified = await this.verify(
          paymentRequest,
          config,
          candidate,
          retriesPerCandidate,
          intervalMs,
        );
        if (verified.verified) {
          const settled = this.settle(candidate, jobIdentity);
          if (settled.accepted) {
            return settled;
          }
          if (settled.reason === 'not-persisted') {
            return settled;
          }
          // Kept as the pass's reason: "this transaction verified but belongs
          // to another job" is the most informative sentence this walk can
          // produce, and dropping it hands the operator whatever earlier
          // candidate happened to fail - or nothing at all.
          lastError = settled.error ?? lastError;
          imperfectPass = true;
          continue;
        }
        // "Not a payment for this request" and "I could not read the chain"
        // arrive as the same `{verified: false}`, so a throttling RPC would
        // otherwise read as "nobody paid".
        imperfectPass = true;
        lastError = verified.error ?? lastError;
      }
    }

    // A budget that ran out while the listing was in flight is only seen here:
    // every check above sits at a step boundary, and an empty page means the
    // candidate loop never runs. Without this, a pass that blew its deadline
    // four times over - or one the caller gave up on - could still be handed
    // `window-empty`, the one verdict a provider may act on, about a look
    // nobody was waiting for.
    //
    // `pastDeadline()` rather than the signal alone: the clock has exactly the
    // same gap, and it is the likelier one to hit. A short `deadlineMs` against
    // a slow RPC is ordinary; an abort arriving in that same window is not.
    if (pastDeadline()) {
      deadlineHit = true;
    }

    // STEP 6 - the verdict, by priority. Reads the FLAG the deadline check set
    // rather than re-reading the clock, so the outcome cannot depend on how warm
    // a module cache is.
    if (deadlineHit) {
      return { accepted: false, reason: 'inconclusive', error: lastError };
    }
    if (isUsableSignature(ownSignature)) {
      return { accepted: false, reason: 'inconclusive', error: lastError };
    }
    if (windowFull) {
      return { accepted: false, reason: 'inconclusive', error: lastError };
    }
    if (!listed || imperfectPass) {
      return { accepted: false, reason: 'inconclusive', error: lastError };
    }
    return { accepted: false, reason: 'window-empty' };
  }

  private async verify(
    paymentRequest: PaymentRequestData,
    config: ProtocolConfigInput,
    txSignature: string,
    retries: number,
    intervalMs: number,
  ): Promise<VerifyResult> {
    return await this.deps.strategy.verifyPayment(this.deps.rpc, paymentRequest, config, {
      txSignature,
      retries,
      intervalMs,
    });
  }

  /**
   * STEP 5 - the claim.
   *
   * Claim exactly the signature we ASKED about - never `VerifyResult.txSignature`,
   * which an injected strategy controls. If this guard fires at all the
   * implementation is broken, and the outcome is spelled out rather than left to
   * chance: treated as `consumed-by-other`, never as an accept.
   */
  private settle(signature: string, jobIdentity: string): AcceptPaymentResult {
    if (!isUsableSignature(signature)) {
      return { accepted: false, reason: 'inconclusive' };
    }
    const claim = this.deps.store.claim(signature, jobIdentity);
    if (claim === 'claimed') {
      return { accepted: true, txSignature: signature };
    }
    if (claim === 'not-persisted') {
      return {
        accepted: false,
        reason: 'not-persisted',
        error: 'the settlement claim could not be written to disk',
      };
    }
    return {
      accepted: false,
      reason: 'inconclusive',
      error: `settlement ${signature} is already bound to another job`,
    };
  }
}
