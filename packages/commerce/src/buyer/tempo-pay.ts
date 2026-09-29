/**
 * Paying an acknowledged order on Tempo, and reconciling it.
 *
 * The rules differ from Solana's where the chain does: a Tempo wallet prompt
 * has no deadline and a relayer can land an approved payment under a new
 * hash, so there is no retry here - an attempt holding a sent hash stays live
 * until it is found, and an attempt proven unpaid (`over`) ends the order with
 * its prompt still open (the store asks for confirmation before any other
 * payment of the product, see `judgeSetMarker`).
 */
import {
  type Asset,
  type ChainConfig,
  type ParsedPaymentRequestV2,
  PaymentRequestV2Schema,
} from '@elisym/pay-core';
import {
  EVM_LATE_PAYMENT_GRACE_SECS,
  type Eip1193Client,
  MIN_PAY_WINDOW_SECS,
  type TempoHeadRef,
  buildTempoPaymentCalls,
  checkEvmChain,
  checkTempoReceivePolicies,
  composeTempoPaymentRequest,
  readFinalizedBlock,
  readTxHash,
  verifyTempoPayment,
} from '@elisym/pay-core/evm';
import { parseCaip19 } from '../caip';
import { isOfferPayout } from '../verify-offer';
import {
  MAX_CLOCK_SKEW_SECS,
  MERCHANT_CATCH_UP_SECS,
  PAY_CUTOFF_SECS,
  STORE_WRITE_ATTEMPTS,
} from './constants';
import { nowSecs } from './events';
import { type LoadedOffer, isSnapshotStale } from './offer';
import { type OrderDeps, sendReceipt } from './order-flow';
import { type OrderRecord, isTerminal } from './order-record';
import type { StoreWrite } from './order-store';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

export interface TempoPayDeps extends OrderDeps {
  /** A read RPC of the record's own Tempo chain. */
  client: Eip1193Client;
  /** The device clock (seconds): the marker's `setAt`, the receipt's date. */
  now?: () => number;
  newAttemptId?: () => string;
}

/** An EIP-1193 wallet, reduced to what one payment needs. */
export interface TempoWallet {
  /** The payer, 0x. */
  address: string;
  /** `eth_chainId` as the WALLET answers it. */
  chainId(): Promise<number>;
  /**
   * `eth_sendTransaction` of one call; resolves the hash the wallet returned.
   * A user refusal rejects with an error carrying `code: 4001`.
   */
  sendCall(call: { from: string; to: string; data: string; chainId: string }): Promise<string>;
}

export type TempoPayRefusal =
  /** The record cannot take a payment now (state, request, the store closed it). */
  | 'not_payable'
  /** The offer snapshot is older than two minutes: verify again. */
  | 'stale_offer'
  /** The store no longer offers this payout at this price: end this order and start a new one. */
  | 'offer_changed'
  /** Too close to the merchant's catch-up end, or to the request's deadline: a new order. */
  | 'too_late'
  /** The payee is a Tempo system address or a coin contract: nothing can pay it. */
  | 'unpayable'
  | 'self_payment'
  | 'insufficient_token'
  /** The recipient's receive policy refuses this payer: the money would sit with the guard. */
  | 'policy_blocked'
  /** The read RPC, or the wallet, is on another chain. */
  | 'wrong_chain'
  /** A chain read failed; nothing was requested. */
  | 'rpc_error'
  | 'exclusion'
  | 'needs_confirmation'
  | 'conflict'
  /** The buyer refused in the wallet (4001): nothing was signed, the order ended. */
  | 'rejected'
  /** The wallet did not answer with a hash: the attempt stays live ("check your wallet"). */
  | 'wallet_failed';

export type TempoPayResult =
  | {
      ok: true;
      record: OrderRecord;
      hash: string;
      /** The hash could not be stored yet: keep it in memory and pass it to the watch. */
      hashUnsaved?: boolean;
    }
  | {
      ok: false;
      reason: TempoPayRefusal;
      record?: OrderRecord;
      holder?: string;
      unconfirmed?: string[];
      /** For `insufficient_token`: subunits. */
      needed?: bigint;
      available?: bigint;
    };

type Refusal = Extract<TempoPayResult, { ok: false }>;

const BALANCE_OF_SELECTOR = '0x70a08231';
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const UINT256_RE = /^0x[0-9a-fA-F]{64}$/;

/** What the buyer keeps beyond the price for the wallet's own fee (MetaMask takes it in the coin). */
export function tempoFeeMargin(decimals: number): bigint {
  return decimals > 2 ? 10n ** BigInt(decimals - 2) : 1n;
}

interface TempoTarget {
  chain: ChainConfig;
  asset: Asset;
  /** The coin's contract, lowercase. */
  token: string;
}

function tempoTargetOf(record: OrderRecord): TempoTarget | undefined {
  const caip19 = parseCaip19(record.payout.caip19);
  const mint = caip19?.asset.mint;
  if (caip19 === undefined || caip19.chain.family !== 'evm' || mint === undefined) {
    return undefined;
  }
  return { chain: caip19.chain, asset: caip19.asset, token: mint.toLowerCase() };
}

/** The request stored on the record, as the schema reads it. */
export function storedTempoRequest(record: OrderRecord): ParsedPaymentRequestV2 | undefined {
  if (record.paymentRequest === undefined) {
    return undefined;
  }
  try {
    const parsed = PaymentRequestV2Schema.safeParse(JSON.parse(record.paymentRequest));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The stored request pays what the record says, with no fee. */
function tempoRequestMatches(
  request: ParsedPaymentRequestV2,
  record: OrderRecord,
  target: TempoTarget,
): boolean {
  return (
    request.chain === target.chain.caip2 &&
    request.asset.toLowerCase() === `${target.chain.caip2}/erc20:${target.token}` &&
    request.recipient === record.payout.address.toLowerCase() &&
    request.memo === record.reference &&
    BigInt(request.amount) === BigInt(record.amount) &&
    request.fee_address === undefined &&
    (request.fee_amount === undefined || BigInt(request.fee_amount) === 0n)
  );
}

/** The chain's time, from its finalized head: what a Tempo order rumor is dated with. */
export async function readTempoChainTime(client: Eip1193Client): Promise<number> {
  const head = await readFinalizedBlock(client);
  if (head === null) {
    throw new Error('The Tempo chain could not be read.');
  }
  return head.timestamp;
}

async function tokenBalance(
  client: Eip1193Client,
  token: string,
  owner: string,
): Promise<bigint | null> {
  try {
    const answer = await client.request({
      method: 'eth_call',
      params: [
        { to: token, data: `${BALANCE_OF_SELECTOR}${owner.slice(2).padStart(64, '0')}` },
        'latest',
      ],
    });
    return typeof answer === 'string' && UINT256_RE.test(answer) ? BigInt(answer) : null;
  } catch {
    return null;
  }
}

function refusal(reason: TempoPayRefusal, record?: OrderRecord): Refusal {
  return record === undefined ? { ok: false, reason } : { ok: false, reason, record };
}

/** End an order nothing was requested for (no marker): no prompt can be open for it. */
async function endNothingRequested(record: OrderRecord, deps: TempoPayDeps): Promise<OrderRecord> {
  const written = await deps.store.update(record.orderId, record.version, {
    state: 'ended-unpaid',
    endedBy: 'nothing',
  });
  return written.ok ? written.record : record;
}

function storeRefusal(written: Extract<StoreWrite, { ok: false }>, record: OrderRecord): Refusal {
  if (written.reason === 'exclusion') {
    return {
      ...refusal('exclusion', record),
      ...(written.holder === undefined ? {} : { holder: written.holder }),
    };
  }
  if (written.reason === 'needs_confirmation') {
    return { ...refusal('needs_confirmation', record), unconfirmed: written.unconfirmed ?? [] };
  }
  return refusal(written.reason === 'conflict' ? 'conflict' : 'not_payable', record);
}

/**
 * Every check that runs BEFORE anything is composed or marked, on the record
 * (not the request): nothing was requested if one fails.
 */
async function checkBeforeTempoPaying(
  record: OrderRecord,
  payer: string,
  fresh: ReadyOffer,
  target: TempoTarget,
  head: TempoHeadRef,
  deps: TempoPayDeps,
): Promise<Refusal | undefined> {
  if (record.state !== 'ordered' || record.marker !== undefined) {
    return refusal('not_payable', record);
  }
  if (isSnapshotStale(fresh.snapshotAt, (deps.now ?? nowSecs)())) {
    return refusal('stale_offer', record);
  }
  const match = fresh.payouts.find(
    (payout) =>
      payout.target.caip19.id === record.payout.caip19 &&
      payout.target.address === record.payout.address,
  );
  if (
    fresh.productAddress !== record.productAddress ||
    !isOfferPayout(fresh.offer, record.payout.caip19, record.payout.address) ||
    match === undefined ||
    match.amount !== BigInt(record.amount)
  ) {
    return refusal('offer_changed', record);
  }
  if (head.timestamp > record.createdAt + MERCHANT_CATCH_UP_SECS - PAY_CUTOFF_SECS) {
    return refusal('too_late', record);
  }
  const recipient = record.payout.address.toLowerCase();
  if (payer === recipient) {
    return refusal('self_payment', record);
  }
  const named = await checkEvmChain(deps.client, target.chain).catch(() => 'wrong' as const);
  if (named === 'wrong') {
    return refusal('wrong_chain', record);
  }
  if (named === null) {
    return refusal('rpc_error', record);
  }
  const policy = await checkTempoReceivePolicies(deps.client, {
    chain: target.chain,
    token: target.token,
    payer,
    recipient,
  });
  if (!policy.ok) {
    return refusal(policy.reason === 'blocked' ? 'policy_blocked' : 'rpc_error', record);
  }
  const balance = await tokenBalance(deps.client, target.token, payer);
  if (balance === null) {
    return refusal('rpc_error', record);
  }
  const needed = BigInt(record.amount) + tempoFeeMargin(target.asset.decimals);
  if (balance < needed) {
    return { ...refusal('insufficient_token', record), needed, available: balance };
  }
  return undefined;
}

interface RequestReady {
  request: ParsedPaymentRequestV2;
  record: OrderRecord;
}

/**
 * The order's request, composed once right after the checks (so a refused
 * balance does not burn its window), or the stored one when it still pays what
 * the record says. `created_at` is the chain's finalized time.
 */
async function requestFor(
  record: OrderRecord,
  target: TempoTarget,
  head: TempoHeadRef,
  deps: TempoPayDeps,
): Promise<RequestReady | Refusal> {
  if (record.paymentRequest !== undefined) {
    const stored = storedTempoRequest(record);
    return stored !== undefined && tempoRequestMatches(stored, record, target)
      ? { request: stored, record }
      : refusal('not_payable', record);
  }
  let request: ParsedPaymentRequestV2;
  try {
    request = composeTempoPaymentRequest({
      chain: target.chain,
      asset: target.asset,
      recipient: record.payout.address.toLowerCase(),
      amount: BigInt(record.amount),
      feeBps: 0,
      treasury: record.payout.address.toLowerCase(),
      memo: record.reference,
      createdAt: head.timestamp,
    });
  } catch {
    return refusal('unpayable', await endNothingRequested(record, deps));
  }
  const written = await deps.store.update(record.orderId, record.version, {
    paymentRequest: JSON.stringify(request),
  });
  if (!written.ok) {
    return storeRefusal(written, record);
  }
  return { request, record: written.record };
}

function isRefusal(value: RequestReady | Refusal): value is Refusal {
  return 'ok' in value;
}

/** Store the hash of attempt `attemptId`, re-reading on a lost compare-and-swap. */
export async function saveTempoHash(
  record: OrderRecord,
  attemptId: string,
  hash: string,
  deps: Pick<TempoPayDeps, 'store'>,
): Promise<{ saved: boolean; record: OrderRecord; stopped?: boolean }> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    const marker = current.marker;
    if (marker?.rail !== 'tempo' || marker.attemptId !== attemptId) {
      return { saved: false, record: current, stopped: true };
    }
    if (marker.txHash === hash) {
      return { saved: true, record: current };
    }
    const written = await deps.store.updateMarker(current.orderId, current.version, attemptId, {
      ...marker,
      txHash: hash,
    });
    if (written.ok) {
      return { saved: true, record: written.record };
    }
    // Another tab ended or settled the record meanwhile: retrying cannot help.
    if (written.reason === 'not_ready') {
      return { saved: false, record: current, stopped: true };
    }
    current = await deps.store.get(record.orderId);
  }
  return { saved: false, record: current ?? record };
}

/**
 * End an attempt the buyer declined (nothing was signed), re-reading on a lost
 * compare-and-swap. Reported as `rejected` only once it ended; otherwise the
 * stored record is handed back to follow (`conflict`).
 */
async function endRejected(
  record: OrderRecord,
  attemptId: string,
  deps: TempoPayDeps,
): Promise<TempoPayResult> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.marker?.attemptId !== attemptId || current.state !== 'paying') {
      break;
    }
    const ended = await deps.store.clearMarker(
      current.orderId,
      current.version,
      attemptId,
      'ended-unpaid',
      'rejected',
    );
    if (ended.ok) {
      return refusal('rejected', ended.record);
    }
    if (ended.reason !== 'conflict') {
      break;
    }
    current = await deps.store.get(record.orderId);
  }
  return refusal('conflict', current ?? record);
}

function isUserRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4001;
}

/**
 * Pay an acknowledged order: checks, the request, the pay floor, the marker
 * (test-and-set with the product exclusion and the old-prompt confirmation),
 * the wallet's chain re-read, ONE `eth_sendTransaction`. A proving rejection
 * ends the order; any other failure keeps the attempt live.
 */
export async function payWithTempo(
  record: OrderRecord,
  wallet: TempoWallet,
  fresh: ReadyOffer,
  deps: TempoPayDeps,
): Promise<TempoPayResult> {
  const target = tempoTargetOf(record);
  const payer = wallet.address.toLowerCase();
  if (target === undefined || !EVM_ADDRESS_RE.test(payer)) {
    return refusal('not_payable', record);
  }
  const head = await readFinalizedBlock(deps.client);
  if (head === null) {
    return refusal('rpc_error', record);
  }
  const failed = await checkBeforeTempoPaying(record, payer, fresh, target, head, deps);
  if (failed !== undefined) {
    return failed;
  }
  const composed = await requestFor(record, target, head, deps);
  if (isRefusal(composed)) {
    return composed;
  }
  const { request } = composed;
  let current = composed.record;
  // A request near its deadline is not paid: the deadline verdict could say
  // "none" while the payment is still in flight.
  if (head.timestamp + MIN_PAY_WINDOW_SECS > request.created_at + request.expiry_secs) {
    return refusal('too_late', await endNothingRequested(current, deps));
  }
  let calls: ReturnType<typeof buildTempoPaymentCalls>;
  try {
    calls = buildTempoPaymentCalls(request, payer);
  } catch {
    return refusal('unpayable', await endNothingRequested(current, deps));
  }
  const call = calls.calls[0];
  if (calls.calls.length !== 1 || call === undefined) {
    return refusal('not_payable', current);
  }
  const now = (deps.now ?? nowSecs)();
  const attemptId = (deps.newAttemptId ?? (() => crypto.randomUUID()))();
  const marked = await deps.store.setMarker(
    current.orderId,
    current.version,
    { rail: 'tempo', attemptId, setAt: now, floorBlock: String(head.number) },
    now,
  );
  if (!marked.ok) {
    return storeRefusal(marked, current);
  }
  current = marked.record;
  // The wallet's own chain, right before sending: a mismatch requested nothing.
  const walletChain = await wallet.chainId().catch(() => undefined);
  if (walletChain !== target.chain.evmChainId) {
    const cleared = await deps.store.clearMarker(
      current.orderId,
      current.version,
      attemptId,
      'ordered',
    );
    return refusal('wrong_chain', cleared.ok ? cleared.record : current);
  }
  let returned: string;
  try {
    returned = await wallet.sendCall({
      from: payer,
      to: call.to,
      data: call.data,
      chainId: calls.chainId,
    });
  } catch (error) {
    if (isUserRejection(error)) {
      return await endRejected(current, attemptId, deps);
    }
    return refusal('wallet_failed', current);
  }
  const hash = readTxHash(returned);
  if (hash === null) {
    return refusal('wallet_failed', current);
  }
  const saved = await saveTempoHash(current, attemptId, hash, deps);
  current = saved.record;
  if (!saved.saved) {
    return { ok: true, record: current, hash, hashUnsaved: true };
  }
  const receipt = await sendReceipt(current, hash, (deps.now ?? nowSecs)(), deps);
  return { ok: true, record: receipt.ok ? receipt.record : current, hash };
}

export type TempoWatch =
  /** The payment was found and recorded. */
  | { state: 'paid'; record: OrderRecord }
  /**
   * Nothing yet, or a sent hash still unresolved: keep watching. `pastDeadline`:
   * the request's late deadline passed and a hash is still unresolved (the
   * "check your wallet, or contact the store" case).
   */
  | { state: 'waiting'; record: OrderRecord; pastDeadline?: boolean }
  /** No hash, no pending call, and a vouched "not paid" past the late deadline. */
  | { state: 'over'; record: OrderRecord }
  /** The money sits with the recipient's transfer-policy guard. */
  | { state: 'blocked'; record: OrderRecord }
  /** The chain answered something no verdict rests on: keep watching, say so after a while. */
  | { state: 'unsure'; record: OrderRecord }
  /** Delivered or refunded: nothing is left to watch. */
  | { state: 'closed'; record: OrderRecord };

export interface TempoWatchOptions {
  /** A hash returned in this session that is not stored yet: it counts as a pending call. */
  pendingHash?: string;
  /** A wallet call of this session is still unanswered. */
  callPending?: boolean;
}

async function recordTempoPaid(
  record: OrderRecord,
  hash: string,
  deps: TempoPayDeps,
): Promise<OrderRecord> {
  let current: OrderRecord | undefined = record;
  if (current.receiptWrap === undefined) {
    const receipt = await sendReceipt(current, hash, (deps.now ?? nowSecs)(), deps);
    if (receipt.ok) {
      current = receipt.record;
    }
  }
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.paidTx !== undefined || isTerminal(current)) {
      return current;
    }
    const written = await deps.store.update(current.orderId, current.version, {
      state: 'paid',
      paidTx: hash,
      paidAt: (deps.now ?? nowSecs)(),
    });
    if (written.ok) {
      return written.record;
    }
    if (written.reason !== 'conflict') {
      return current;
    }
    current = await deps.store.get(record.orderId);
  }
  return current ?? record;
}

async function recordBlocked(record: OrderRecord, deps: TempoPayDeps): Promise<OrderRecord> {
  const written = await deps.store.update(record.orderId, record.version, { state: 'blocked' });
  return written.ok ? written.record : record;
}

/**
 * One reconciliation step for a Tempo attempt, or for a Tempo order that ended
 * `over` (its prompt can still be approved). Only `none` with no hash, no
 * pending call and a live attempt - the verifier vouches `none` only past the
 * late deadline - is `over`.
 */
export async function watchTempoPayment(
  record: OrderRecord,
  deps: TempoPayDeps,
  options: TempoWatchOptions = {},
): Promise<TempoWatch> {
  if (isTerminal(record)) {
    return { state: 'closed', record };
  }
  if (record.paidTx !== undefined) {
    return { state: 'paid', record: await recordTempoPaid(record, record.paidTx, deps) };
  }
  const request = storedTempoRequest(record);
  if (record.marker?.rail !== 'tempo' || request === undefined) {
    return { state: 'waiting', record };
  }
  let current = record;
  if (
    options.pendingHash !== undefined &&
    record.marker.txHash === undefined &&
    record.state === 'paying'
  ) {
    current = (await saveTempoHash(record, record.marker.attemptId, options.pendingHash, deps))
      .record;
  }
  const marker = current.marker?.rail === 'tempo' ? current.marker : record.marker;
  const hash = marker.txHash ?? options.pendingHash;
  const result = await verifyTempoPayment(deps.client, request, {
    ...(hash === undefined ? {} : { txSignature: hash }),
    fromBlock: Number(marker.floorBlock),
    pollBudgetMs: 0,
  });
  switch (result.outcome) {
    case 'verified':
      return {
        state: 'paid',
        record: await recordTempoPaid(current, result.providerLeg.transactionHash, deps),
      };
    case 'none': {
      const held =
        hash !== undefined || options.callPending === true || marker.bundleId !== undefined;
      if (!held && current.state === 'paying') {
        return { state: 'over', record: current };
      }
      return { state: 'waiting', record: current, pastDeadline: hash !== undefined };
    }
    case 'refused':
      switch (result.code) {
        case 'provider_leg_blocked':
          return { state: 'blocked', record: await recordBlocked(current, deps) };
        case 'wrong_chain':
        case 'unknown_asset':
        case 'unreadable_receipt':
        case 'reverted':
        case 'no_provider_leg':
        case 'fee_leg_missing':
        case 'fee_leg_blocked':
          return { state: 'unsure', record: current };
      }
      return { state: 'unsure', record: current };
    case 'inconclusive':
      switch (result.reason) {
        case 'not_yet_due':
        case 'not_finalized':
        case 'no_receipt':
        case 'chain_unreadable':
          return { state: 'waiting', record: current };
        case 'incomplete_scan':
        case 'control_failed':
          return { state: 'unsure', record: current };
      }
      return { state: 'unsure', record: current };
  }
}

/** The late deadline of a request: after it a vouched "not paid" is final for an attempt with no hash. */
export function tempoLateDeadline(request: ParsedPaymentRequestV2): number {
  return request.created_at + request.expiry_secs + EVM_LATE_PAYMENT_GRACE_SECS;
}

/**
 * End a Tempo order that will not be paid: at once when nothing was requested;
 * with an attempt, only once the watch proves it over - it ends `over`, its
 * prompt still open.
 */
export async function endTempoOrder(
  record: OrderRecord,
  deps: TempoPayDeps,
  options: TempoWatchOptions = {},
): Promise<{ ended: boolean; record: OrderRecord }> {
  if (record.state === 'ordered' && record.marker === undefined) {
    const ended = await endNothingRequested(record, deps);
    return { ended: ended.state === 'ended-unpaid', record: ended };
  }
  if (record.state !== 'paying' || record.marker?.rail !== 'tempo') {
    return { ended: false, record };
  }
  const watch = await watchTempoPayment(record, deps, options);
  if (watch.state !== 'over' || watch.record.marker === undefined) {
    return { ended: false, record: watch.record };
  }
  const written = await deps.store.clearMarker(
    watch.record.orderId,
    watch.record.version,
    watch.record.marker.attemptId,
    'ended-unpaid',
    'over',
  );
  return written.ok
    ? { ended: true, record: written.record }
    : { ended: false, record: watch.record };
}

/**
 * Whether an ended Tempo order may still be paid: it ended `over` (or with no
 * reason, fail closed) inside the merchant's catch-up, judged on the device
 * clock with the skew allowance. The same predicate as the store's
 * confirmation, for the per-load reconciliation.
 */
export function mayStillBePaid(record: OrderRecord, now: number): boolean {
  return (
    record.state === 'ended-unpaid' &&
    record.payout.caip19.startsWith('eip155:') &&
    (record.endedBy === 'over' || record.endedBy === undefined) &&
    now - record.createdAt <= MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS
  );
}
