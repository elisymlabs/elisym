/**
 * Verifying that a Tempo payment request was paid.
 *
 * This is the provider's money core, and it answers in four words, never in a
 * boolean: `verified` (the money is there), `none` (it looked completely and
 * nothing was ever sent), `inconclusive` (it could not look, or the window is
 * still open) and `refused` (something is on chain, and it is not this payment).
 * Only `none` and `refused` are terminal; everything else says "ask again".
 *
 * It reads NO protocol config. Every number it matches against - the treasury,
 * the fee, the amount, the memo - comes from the persisted request, so rotating
 * the treasury or switching the fee on cannot orphan a request already paid.
 *
 * What a wallet reports is not evidence. The transaction's `from` and `to`
 * appear in no check here: a leg found by memo counts as done whoever paid it,
 * because the memo is what binds a transfer to this request and nothing else
 * does. A relayer, a batcher or a friend may have sent it.
 */

import { chainByCaip2 } from '../payment/chains';
import type { ParsedPaymentRequestV2 } from '../payment/schema-v2';
import { resolveAssetFromPaymentRequestV2 } from '../payment/schema-v2';
import type { Eip1193Client } from './client';
import { withAbort } from './client';
import { assertEvmChain, WrongEvmChainError } from './config';
import {
  EVM_LATE_PAYMENT_GRACE_SECS,
  TEMPO_LIVE_NOHASH_BUDGET_MS,
  TEMPO_LIVE_POLL_INTERVAL_MS,
} from './constants';
import type { TempoBlockedLog, TempoTransferLog } from './logs';
import {
  decodeTempoBlockedLog,
  decodeTempoTransferLog,
  listTempoBlockedLogs,
  listTempoLogs,
  passesHistoryControl,
  readBlockByNumber,
  readFinalizedBlock,
} from './logs';
import { readBlockNumber, readField, readTxHash } from './rpc-read';

export type TempoInconclusiveReason =
  | 'no_receipt'
  | 'not_finalized'
  | 'incomplete_scan'
  | 'control_failed'
  /** A basic chain read (`eth_chainId`, the finalized head, a block) did not answer. */
  | 'chain_unreadable'
  /** Nothing yet, and the payment window has not closed. The normal live answer. */
  | 'not_yet_due';

export type TempoRefusalCode =
  | 'wrong_chain'
  /** The request names a token this SDK's registry does not carry for that chain. */
  | 'unknown_asset'
  | 'unreadable_receipt'
  | 'reverted'
  | 'no_provider_leg'
  | 'fee_leg_missing'
  | 'fee_leg_blocked'
  | 'provider_leg_blocked';

export type TempoVerifyResult =
  | {
      outcome: 'verified';
      /** `<caip2>:<hash>:<memo>`. Stored verbatim; nothing parses it back. */
      settlementId: string;
      providerLeg: TempoTransferLog;
      feeLeg?: TempoTransferLog;
    }
  | { outcome: 'none' }
  | { outcome: 'inconclusive'; reason: TempoInconclusiveReason }
  | { outcome: 'refused'; code: TempoRefusalCode };

export interface VerifyTempoPaymentOptions {
  /** The hash the customer reported, when there is one. */
  txSignature?: string;
  /** The finalized number read when the request was issued: the floor of every scan. */
  fromBlock: number;
  signal?: AbortSignal;
  /**
   * How long the no-hash path may keep looking. Zero means one pass - what
   * recovery and reconciliation want. The live path is bounded on purpose: one
   * unpaid job must not pin a provider slot for the whole payment window.
   */
  pollBudgetMs?: number;
  pollIntervalMs?: number;
}

interface VerifyContext {
  client: Eip1193Client;
  request: ParsedPaymentRequestV2;
  /** The token's contract, from the SDK registry only. */
  token: string;
  /** What the provider's own leg must carry: the total less the fee. */
  providerMin: bigint;
  feeAmount: bigint;
  feeAddress?: string;
  fromBlock: number;
  signal?: AbortSignal;
}

function refused(code: TempoRefusalCode): TempoVerifyResult {
  return { outcome: 'refused', code };
}

function inconclusive(reason: TempoInconclusiveReason): TempoVerifyResult {
  return { outcome: 'inconclusive', reason };
}

/** One function builds it, from what was ASKED and what the request says. */
export function tempoSettlementId(request: ParsedPaymentRequestV2, hash: string): string {
  return `${request.chain}:${hash}:${request.memo}`;
}

/**
 * Is the chain past the moment after which "nothing arrived" may be believed?
 *
 * The clock is the CHAIN's, not the verifier's: the block a scan reached carries
 * the only timestamp both sides of a dispute can read. A payment that lands
 * after its request expired is still the customer's money, so the expiry alone
 * is not the deadline - the grace is what makes a late payment creditable.
 */
function isPastLateDeadline(request: ParsedPaymentRequestV2, blockTimestamp: number): boolean {
  return blockTimestamp > request.created_at + request.expiry_secs + EVM_LATE_PAYMENT_GRACE_SECS;
}

/** Resolves early when the caller gives up, so a budget is never overrun by a pause. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Verify one payment request against the chain.
 *
 * With a hash it is one pass over that receipt. Without one it scans for the
 * memo, and on the live path keeps looking until its budget runs out - the only
 * loop here, and a bounded one.
 */
export async function verifyTempoPayment(
  client: Eip1193Client,
  request: ParsedPaymentRequestV2,
  options: VerifyTempoPaymentOptions,
): Promise<TempoVerifyResult> {
  const chain = chainByCaip2(request.chain);
  if (chain === undefined || chain.family !== 'evm') {
    return refused('wrong_chain');
  }
  const asset = resolveAssetFromPaymentRequestV2(request);
  const token = asset?.mint;
  if (token === undefined) {
    return refused('unknown_asset');
  }
  try {
    await assertEvmChain(client, chain);
  } catch (error) {
    // A wrong chain is a wrong request; an unreadable one is a failed look.
    return error instanceof WrongEvmChainError
      ? refused('wrong_chain')
      : inconclusive('chain_unreadable');
  }

  const feeAmount = request.fee_amount === undefined ? 0n : BigInt(request.fee_amount);
  const context: VerifyContext = {
    client,
    request,
    token,
    providerMin: BigInt(request.amount) - feeAmount,
    feeAmount,
    ...(request.fee_address === undefined ? {} : { feeAddress: request.fee_address }),
    fromBlock: options.fromBlock,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const hash = options.txSignature === undefined ? null : readTxHash(options.txSignature);
  if (hash === null) {
    // No hash, or something that was never one: the memo is the only handle.
    return verifyWithPolling(context, options);
  }
  const byHash = await verifyByHash(context, hash);
  if (byHash.outcome !== 'refused') {
    return byHash;
  }
  // Every refusal here is about ONE transaction - the one somebody named - and
  // none of them proves that no OTHER transaction paid. A wallet reports a
  // bundle id, an approve, or the first of two; a first attempt is blocked and
  // a second one succeeds. The Solana rail races the two paths for the same
  // reason. The money is one `eth_getLogs` away and a refusal is terminal, so
  // it is not a refusal until the memo has been looked for too. The named
  // transaction's verdict still stands when nothing else paid: it is the more
  // specific answer, and the one the customer can act on.
  const byMemo = await verifyWithoutHash(context);
  return byMemo.outcome === 'verified' ? byMemo : byHash;
}

async function verifyWithPolling(
  context: VerifyContext,
  options: VerifyTempoPaymentOptions,
): Promise<TempoVerifyResult> {
  const budget = options.pollBudgetMs ?? TEMPO_LIVE_NOHASH_BUDGET_MS;
  const interval = options.pollIntervalMs ?? TEMPO_LIVE_POLL_INTERVAL_MS;
  const deadline = Date.now() + budget;
  let result = await verifyWithoutHash(context);
  while (result.outcome === 'inconclusive') {
    if (context.signal?.aborted || Date.now() + interval >= deadline) {
      return result;
    }
    await sleep(interval, context.signal);
    if (context.signal?.aborted) {
      return result;
    }
    result = await verifyWithoutHash(context);
  }
  return result;
}

/** Rules 2-6: one receipt, by the hash somebody reported. */
async function verifyByHash(context: VerifyContext, hash: string): Promise<TempoVerifyResult> {
  const receipt = await withAbort(
    context.client.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
    context.signal,
  ).catch(() => undefined);
  if (receipt === null) {
    // The node knows the chain and has no such transaction: not seen YET.
    return inconclusive('no_receipt');
  }
  if (receipt === undefined) {
    return inconclusive('chain_unreadable');
  }
  const status = readField(receipt, 'status');
  if (status === '0x0') {
    return refused('reverted');
  }
  const blockNumber = readBlockNumber(readField(receipt, 'blockNumber'));
  const logs = readField(receipt, 'logs');
  if (
    status !== '0x1' ||
    readTxHash(readField(receipt, 'transactionHash')) !== hash ||
    blockNumber === null ||
    !Array.isArray(logs)
  ) {
    return refused('unreadable_receipt');
  }

  const finalized = await readFinalizedBlock(context.client);
  if (finalized === null) {
    return inconclusive('chain_unreadable');
  }
  if (blockNumber > finalized.number) {
    return inconclusive('not_finalized');
  }

  // Rule 3: only this transaction's logs, from the REGISTRY token, of the memo
  // event, whole. Anything else is not counted - it can cost a refusal, never a
  // credit.
  const transfers: TempoTransferLog[] = [];
  for (const entry of logs) {
    const decoded = decodeTempoTransferLog(entry, 'TransferWithMemo', context.token);
    if (decoded.kind === 'log' && decoded.log.transactionHash === hash) {
      transfers.push(decoded.log);
    }
  }

  const providerLeg = transfers.find((log) => isProviderLeg(context, log));
  if (providerLeg === undefined) {
    return blockedInReceipt(context, logs, hash, context.request.recipient, context.providerMin)
      ? refused('provider_leg_blocked')
      : refused('no_provider_leg');
  }

  if (context.feeAddress === undefined) {
    return {
      outcome: 'verified',
      settlementId: tempoSettlementId(context.request, hash),
      providerLeg,
    };
  }

  const feeLeg = transfers.find(
    (log) =>
      isFeeLeg(context, log) &&
      !(
        log.transactionHash === providerLeg.transactionHash && log.logIndex === providerLeg.logIndex
      ),
  );
  if (feeLeg !== undefined) {
    return {
      outcome: 'verified',
      settlementId: tempoSettlementId(context.request, hash),
      providerLeg,
      feeLeg,
    };
  }
  if (blockedInReceipt(context, logs, hash, context.feeAddress, context.feeAmount)) {
    return refused('fee_leg_blocked');
  }
  // The legs may have been paid by two transactions (a wallet that cannot
  // batch), so a receipt without the fee leg is not yet an answer.
  return verifyFeeLegElsewhere(context, hash, providerLeg, finalized.number);
}

function isProviderLeg(context: VerifyContext, log: TempoTransferLog): boolean {
  return (
    log.to === context.request.recipient &&
    log.memo === context.request.memo &&
    log.amount >= context.providerMin &&
    log.from !== log.to
  );
}

function isFeeLeg(context: VerifyContext, log: TempoTransferLog): boolean {
  return (
    context.feeAddress !== undefined &&
    log.to === context.feeAddress &&
    log.memo === context.request.memo &&
    log.amount >= context.feeAmount &&
    log.from !== log.to
  );
}

/**
 * A guard log in THIS receipt saying that a leg to `recipient` was refused.
 *
 * Rule 3's transaction bound applies here exactly as it does to transfer logs:
 * an entry naming another transaction is not this receipt's evidence, and
 * reading it as such lets one crafted log flip a paid job to a terminal refusal.
 */
function blockedInReceipt(
  context: VerifyContext,
  logs: readonly unknown[],
  hash: string,
  recipient: string,
  minAmount: bigint,
): boolean {
  for (const entry of logs) {
    const decoded = decodeTempoBlockedLog(entry);
    if (
      decoded.kind === 'log' &&
      decoded.log.transactionHash === hash &&
      matchesBlockedLeg(context, decoded.log, recipient, minAmount)
    ) {
      return true;
    }
  }
  return false;
}

function matchesBlockedLeg(
  context: VerifyContext,
  blocked: TempoBlockedLog,
  recipient: string,
  minAmount: bigint,
): boolean {
  return (
    blocked.token === context.token &&
    blocked.receiver === recipient &&
    blocked.memo === context.request.memo &&
    blocked.amount >= minAmount
  );
}

/**
 * The fee leg in its own transaction. Its absence is only an answer once the
 * window has closed: a wallet that cannot batch pays the two legs seconds apart,
 * and refusing in between would fail a job whose provider leg is already paid.
 */
async function verifyFeeLegElsewhere(
  context: VerifyContext,
  hash: string,
  providerLeg: TempoTransferLog,
  head: number,
): Promise<TempoVerifyResult> {
  if (context.feeAddress === undefined) {
    return inconclusive('incomplete_scan');
  }
  const scan = await listTempoLogs(context.client, {
    token: context.token,
    event: 'TransferWithMemo',
    to: context.feeAddress,
    memo: context.request.memo,
    minAmount: context.feeAmount,
    fromBlock: context.fromBlock,
    toBlock: head,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const feeLeg = scan.candidates.find((log) => isFeeLeg(context, log));
  if (feeLeg !== undefined) {
    return {
      outcome: 'verified',
      settlementId: tempoSettlementId(context.request, hash),
      providerLeg,
      feeLeg,
    };
  }
  if (!scan.complete || scan.toBlock === null || scan.toBlock < providerLeg.blockNumber) {
    return inconclusive('incomplete_scan');
  }
  const blocked = await findBlockedLeg(
    context,
    context.feeAddress,
    context.feeAmount,
    scan.toBlock,
  );
  if (blocked === 'blocked') {
    return refused('fee_leg_blocked');
  }
  if (blocked === 'unknown') {
    return inconclusive('incomplete_scan');
  }
  const edge = await readBlockByNumber(context.client, scan.toBlock);
  if (edge === null) {
    return inconclusive('chain_unreadable');
  }
  if (!isPastLateDeadline(context.request, edge.timestamp)) {
    return inconclusive('not_yet_due');
  }
  // The same claim as `none` - "it is not on chain" - so the same proof. A node
  // that under-serves this window answers an empty list with no error, and
  // without the control a customer who paid BOTH legs loses the job.
  return (await vouchedFor(context, scan.toBlock))
    ? refused('fee_leg_missing')
    : inconclusive('control_failed');
}

/**
 * Does this endpoint actually serve this token's logs at both ends of the scan?
 *
 * A node with pruned logs answers `[]` with no error, and an empty answer is
 * exactly what "nobody paid" looks like - so no verdict that rests on an empty
 * window may be reached without this.
 */
async function vouchedFor(context: VerifyContext, toBlock: number): Promise<boolean> {
  const floorVouched = await passesHistoryControl(context.client, {
    token: context.token,
    edgeBlock: context.fromBlock,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const headVouched = await passesHistoryControl(context.client, {
    token: context.token,
    edgeBlock: toBlock,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return floorVouched && headVouched;
}

/** Rule 10, as a lookup: was a leg to `recipient` blocked by its own policy? */
async function findBlockedLeg(
  context: VerifyContext,
  recipient: string,
  minAmount: bigint,
  toBlock: number,
): Promise<'blocked' | 'clear' | 'unknown'> {
  const scan = await listTempoBlockedLogs(context.client, {
    token: context.token,
    receiver: recipient,
    fromBlock: context.fromBlock,
    toBlock,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (scan.candidates.some((log) => matchesBlockedLeg(context, log, recipient, minAmount))) {
    return 'blocked';
  }
  return scan.complete ? 'clear' : 'unknown';
}

/** Rules 7-10: no hash, so the memo is the only handle there is. */
async function verifyWithoutHash(context: VerifyContext): Promise<TempoVerifyResult> {
  const scan = await listTempoLogs(context.client, {
    token: context.token,
    event: 'TransferWithMemo',
    to: context.request.recipient,
    memo: context.request.memo,
    minAmount: context.providerMin,
    fromBlock: context.fromBlock,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  // A candidate is worth a full check whether or not the pass was complete:
  // incompleteness only ever blocks the "nothing was sent" verdict.
  let best: TempoVerifyResult | null = null;
  for (const candidate of scan.candidates) {
    if (!isProviderLeg(context, candidate)) {
      continue;
    }
    const result = await verifyByHash(context, candidate.transactionHash);
    if (result.outcome === 'verified') {
      return result;
    }
    // Never let a refusal over one candidate bury an unknown over another.
    if (best === null || (best.outcome === 'refused' && result.outcome === 'inconclusive')) {
      best = result;
    }
  }
  if (best !== null) {
    return best;
  }
  if (!scan.complete || scan.toBlock === null) {
    return inconclusive('incomplete_scan');
  }

  // Nothing found, and the look was complete. Rule 10 before rule 9: a transfer
  // the recipient's own policy refused is not a transfer that never happened.
  const blocked = await findBlockedLeg(
    context,
    context.request.recipient,
    context.providerMin,
    scan.toBlock,
  );
  if (blocked === 'blocked') {
    return refused('provider_leg_blocked');
  }
  if (blocked === 'unknown') {
    return inconclusive('incomplete_scan');
  }

  const edge = await readBlockByNumber(context.client, scan.toBlock);
  if (edge === null) {
    return inconclusive('chain_unreadable');
  }
  if (!isPastLateDeadline(context.request, edge.timestamp)) {
    return inconclusive('not_yet_due');
  }
  // Both edges of the scan, AFTER the scan.
  if (!(await vouchedFor(context, scan.toBlock))) {
    return inconclusive('control_failed');
  }
  return { outcome: 'none' };
}
