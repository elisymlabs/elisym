/**
 * Terminal-bounded settlement helpers for money-moving transactions.
 *
 * The root question every helper here answers: "is this transaction provably
 * terminal?" A client-side confirmation timeout, an RPC hiccup, or a crash
 * between send and confirm must never be read as "the funds did not move".
 *
 * - {@link isDefinitelyUnpaid} - the financial retry/release guard (extracted
 *   from the MCP server): positive evidence of absence, else assume-landed.
 * - {@link buildSignedPull} / {@link sendConfirmToTerminal} /
 *   {@link confirmPullToTerminal} - the two-phase delegated-pull flow. Phase A
 *   signs and exposes `{signature, lastValidBlockHeight}` so the caller can
 *   PERSIST them before any bytes hit the network; phase B sends and polls to a
 *   provable terminal: landed, or the blockhash lifetime is over.
 *
 * The SDK never constructs RPCs - callers inject `Rpc<SolanaRpcApi>` (DI).
 * Http-only by design: confirmation polls `getSignatureStatuses` +
 * `getBlockHeight`, no WebSocket subscriptions.
 */

import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';
import type { Signer } from './strategy';

/** Re-poll settings for the absent-from-chain case (see isDefinitelyUnpaid). */
const UNPAID_RECHECK_ATTEMPTS = 3;
const UNPAID_RECHECK_DELAY_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Financial retry/release guard: has the payment tx DEFINITELY not moved funds?
 *
 * A send/confirm failure does not prove the tx failed - it may have landed.
 * Callers use this on that failure path to decide whether to release a spend
 * reservation or report a retryable failure - which must only happen when no
 * funds moved. Returns `true` only with POSITIVE evidence of that: the
 * signature stays absent from the chain across a short re-poll (guarding a
 * landed-but-not-yet-indexed tx), or is present but reverted (on-chain error).
 * Returns `false` when the tx is on-chain without error (funds moved, incl.
 * merely 'processed') OR when the state could not be determined (RPC failure) -
 * on that indeterminate case the caller must assume the tx MAY have landed and
 * NOT release/retry (else a double withdrawal or an under-counted spend cap on
 * a transient RPC error).
 *
 * `opts.recheckAttempts` exists so a crash-recovery reconcile path can re-poll
 * harder than a live release path (a false "absent" there means a customer was
 * charged with no result).
 *
 * CAVEAT: "absent" is only as strong as the queried node's retained history.
 * `searchTransactionHistory` cannot see a tx that aged out of the node's
 * ledger retention (typically a few days on non-archive RPCs), so a reconcile
 * that first runs after downtime longer than that can misread a landed tx as
 * dead - reporting "not charged" to a customer who was charged. Same class of
 * limitation as `reVerifyPayment`'s documented on-chain-data-expiry bound: on
 * mainnet, configure an archive RPC via `SOLANA_RPC_URL` or bound downtime.
 */
export async function isDefinitelyUnpaid(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  opts: { recheckAttempts?: number; recheckDelayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.recheckAttempts ?? UNPAID_RECHECK_ATTEMPTS;
  const delayMs = opts.recheckDelayMs ?? UNPAID_RECHECK_DELAY_MS;
  // A `null` status is ambiguous right after a confirmation timeout: the tx may be
  // genuinely absent, OR it landed and the queried RPC node has not indexed it yet
  // (propagation lag). Re-poll a few times before concluding absent - a false "absent"
  // here is the exact failure this guard exists to prevent (a caller would release a
  // reservation or retry a withdrawal that actually moved funds). A landed/reverted
  // status or an RPC error short-circuits immediately.
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await delay(delayMs);
    }
    try {
      const { value } = await rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .send();
      const status = value[0];
      if (status) {
        // On-chain: definitely unpaid only if it reverted (no transfer happened).
        return Boolean(status.err);
      }
    } catch {
      return false; // could not determine -> assume the tx may have landed
    }
  }
  return true; // absent across every re-poll -> genuinely not on-chain
}

/**
 * Phase-A output: everything a caller must PERSIST before phase B sends. The
 * signature is the durable idempotency key; `lastValidBlockHeight` is the
 * provable terminal bound - once the chain's block height passes it, this exact
 * transaction can never land, so "absent past that height" means dead.
 */
export interface SignedPullTransaction {
  /** The fully signed transaction, ready for phase B. */
  transaction: Readonly<unknown>;
  /** The tx signature, derivable before sending (durable idempotency key). */
  signature: Signature;
  /** The blockhash lifetime bound. Persist as `Number(...)` (JSON-safe). */
  lastValidBlockHeight: bigint;
}

/**
 * Phase A of the two-phase pull: fetch a fresh blockhash, compile, and sign -
 * WITHOUT sending. The caller persists `{signature, lastValidBlockHeight}` and
 * only then runs phase B, so a crash between the two leaves a resolvable
 * phantom (the persisted signature goes provably dead at blockhash expiry, with
 * no charge) instead of an untracked in-flight transfer.
 */
export async function buildSignedPull(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: Signer,
  instructions: readonly unknown[],
): Promise<SignedPullTransaction> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        m,
      ),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  return {
    transaction,
    signature: getSignatureFromTransaction(
      transaction as Parameters<typeof getSignatureFromTransaction>[0],
    ),
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  };
}

/**
 * How a pull resolved against its terminal bound:
 * - `landed` - the signature is on-chain without error (funds moved).
 * - `assume-landed` - the blockhash is past terminal but absence could NOT be
 *   positively proven ({@link isDefinitelyUnpaid} returned false). Money rule:
 *   treat as landed.
 * - `dead` - provably no funds moved: reverted on-chain, or absent after the
 *   terminal bound with positive re-poll evidence.
 * - `unresolved` - the poll budget ran out BEFORE the terminal bound was
 *   reached (persistent RPC failure). Nothing is proven; the caller must keep
 *   its persisted state and re-run {@link confirmPullToTerminal} later.
 */
export type PullTerminalOutcome = 'landed' | 'assume-landed' | 'dead' | 'unresolved';

export interface ConfirmToTerminalOptions {
  /** Delay between status polls. Default 2000ms. */
  pollIntervalMs?: number;
  /** Hard cap on poll iterations (errors count). Default 90. */
  maxAttempts?: number;
  /** Hard wall-clock cap on the whole poll. Default 180_000ms. */
  maxDurationMs?: number;
  /** Forwarded to {@link isDefinitelyUnpaid} at the terminal check. */
  recheckAttempts?: number;
  recheckDelayMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 90;
const DEFAULT_MAX_DURATION_MS = 180_000;

/**
 * Poll a persisted pull signature to its terminal bound: landed, or the chain's
 * block height has passed `lastValidBlockHeight` (the tx can never land). Only
 * AFTER that terminal does it consult {@link isDefinitelyUnpaid} - so `dead` is
 * always a positive proof, never a timeout guess. The poll itself is bounded by
 * plain max-attempts / max-duration caps (a persistently-erroring RPC must not
 * hang the caller); exhaustion returns `unresolved`, not `dead`.
 *
 * Shared by the live path (right after send) and crash recovery (re-polling a
 * persisted signature) - both must resolve the same way.
 */
export async function confirmPullToTerminal(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  lastValidBlockHeight: bigint,
  opts: ConfirmToTerminalOptions = {},
): Promise<PullTerminalOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const started = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      if (Date.now() - started + pollIntervalMs > maxDurationMs) {
        break;
      }
      await delay(pollIntervalMs);
    }
    try {
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      const status = value[0];
      if (status) {
        // Reverted on-chain is terminal AND provably moved no funds.
        return status.err ? 'dead' : 'landed';
      }
      const blockHeight = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
      if (blockHeight > lastValidBlockHeight) {
        // Terminal: this blockhash can never land now. `isDefinitelyUnpaid`
        // re-polls WITH `searchTransactionHistory`, catching a tx that landed
        // long ago and aged out of the recent-status cache (restart recovery).
        const unpaid = await isDefinitelyUnpaid(rpc, signature, {
          recheckAttempts: opts.recheckAttempts,
          recheckDelayMs: opts.recheckDelayMs,
        });
        return unpaid ? 'dead' : 'assume-landed';
      }
    } catch {
      // Transient RPC failure: burns an attempt, never resolves the outcome.
    }
  }
  return 'unresolved';
}

/**
 * Phase B of the two-phase pull: broadcast (http, no confirmation, no WS), then
 * poll to the terminal bound. A send error is swallowed deliberately - the
 * bytes may have reached the cluster anyway, so only the terminal-bounded poll
 * is allowed to decide the outcome.
 */
export async function sendConfirmToTerminal(
  rpc: Rpc<SolanaRpcApi>,
  pull: SignedPullTransaction,
  opts: ConfirmToTerminalOptions = {},
): Promise<PullTerminalOutcome> {
  const send = sendTransactionWithoutConfirmingFactory({ rpc });
  try {
    await send(pull.transaction as Parameters<typeof send>[0], { commitment: 'confirmed' });
  } catch {
    // The tx may still be in flight; the terminal-bounded poll resolves it.
  }
  return confirmPullToTerminal(rpc, pull.signature, pull.lastValidBlockHeight, opts);
}
