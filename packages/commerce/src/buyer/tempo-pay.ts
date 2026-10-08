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
  MAX_FEE_BPS,
  type ParsedPaymentRequestV2,
  PaymentRequestV2Schema,
  calculateProtocolFeeSubunits,
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
import {
  type FeePlan,
  type FeeRefusal,
  type FeeTermsSource,
  planFee,
  sameFeePlan,
  storedFeePlan,
} from './fee';
import { type LoadedOffer, isSnapshotStale } from './offer';
import { type OrderDeps, sendReceipt } from './order-flow';
import { type OrderRecord, type PaymentMarker, isTerminal } from './order-record';
import type { StoreWrite } from './order-store';

type TempoMarker = Extract<PaymentMarker, { rail: 'tempo' }>;

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

export interface TempoPayDeps extends OrderDeps {
  /** A read RPC of the record's own Tempo chain. */
  client: Eip1193Client;
  /** The device clock (seconds): the marker's `setAt`, the receipt's date. */
  now?: () => number;
  newAttemptId?: () => string;
  /** The protocol fee terms of a chain, read fresh before the marker (`planFee`). */
  feeTerms: FeeTermsSource;
}

/** What following and ending an attempt needs: no fee terms (nothing is composed or signed). */
export type TempoWatchDeps = Omit<TempoPayDeps, 'feeTerms'>;

/**
 * `wallet_getCallsStatus` (EIP-5792), as far as the buyer reads it: `100`
 * pending, `200` confirmed, `400` / `500` failed for good, `600` partly
 * reverted. `receipts` carry the transaction hashes.
 */
export interface CallsStatus {
  status: number;
  atomic?: boolean;
  receipts?: readonly { transactionHash?: unknown }[];
}

/** An EIP-1193 wallet, reduced to what one payment needs. */
export interface TempoWallet {
  /** The payer, 0x. */
  address: string;
  /** The EIP-6963 `rdns` of the wallet, when known: recorded with an approved bundle. */
  rdns?: string;
  /** `eth_chainId` as the WALLET answers it. */
  chainId(): Promise<number>;
  /**
   * `eth_sendTransaction` of one call; resolves the hash the wallet returned.
   * A user refusal rejects with an error carrying `code: 4001`.
   */
  sendCall(call: { from: string; to: string; data: string; chainId: string }): Promise<string>;
  /** `wallet_getCapabilities` for the payer on this chain: whether it batches atomically. */
  capabilities?(chainId: string): Promise<{ atomic: boolean }>;
  /** `wallet_sendCalls` with `atomicRequired: true`; resolves the bundle id. */
  sendCalls?(request: {
    from: string;
    chainId: string;
    calls: readonly { to: string; data: string }[];
  }): Promise<{ bundleId: string }>;
  /** `wallet_getCallsStatus` of a bundle this wallet approved. */
  callsStatus?(bundleId: string): Promise<CallsStatus>;
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
  /** The buyer refused in the wallet (4001, 5750): nothing was signed, the order ended. */
  | 'rejected'
  /** The wallet did not answer with a hash: the attempt stays live ("check your wallet"). */
  | 'wallet_failed'
  /**
   * The payment carries a fee leg and the wallet cannot send both legs in one
   * atomic batch: nothing was requested, the order stays `ordered` (another
   * wallet can pay it).
   */
  | 'wallet_cannot_batch'
  /** See `FeeRefusal`: `store_outdated` ends the order at the caller, the others leave it. */
  | FeeRefusal;

export type TempoPayResult =
  | {
      ok: true;
      record: OrderRecord;
      hash: string;
      /** The hash could not be stored yet: keep it in memory and pass it to the watch. */
      hashUnsaved?: boolean;
    }
  | {
      ok: true;
      record: OrderRecord;
      /** A fee-bearing payment went out as one atomic bundle: its hash comes later (`followTempoBundle`). */
      bundleId: string;
      /** The bundle id could not be stored yet: keep it in memory (`pendingBundleId`). */
      bundleUnsaved?: boolean;
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

/**
 * The stored request pays what the record says: chain, coin, payee, memo,
 * total. Structural only: its fee leg is compared with a fresh plan in a step
 * of its own, whose refusal ends the order (`offer_changed`).
 */
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
    BigInt(request.amount) === BigInt(record.amount)
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
async function endNothingRequested(
  record: OrderRecord,
  deps: TempoWatchDeps,
): Promise<OrderRecord> {
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
 * Whether `wallet` can send a fee-bearing payment: both legs in ONE atomic
 * batch (`wallet_getCapabilities` says `atomic`, and it can send and follow a
 * bundle). A wallet that cannot is refused before anything is requested.
 */
export async function tempoWalletCanBatch(
  wallet: Pick<TempoWallet, 'capabilities' | 'sendCalls' | 'callsStatus'>,
  chainId: string,
): Promise<boolean> {
  if (
    wallet.capabilities === undefined ||
    wallet.sendCalls === undefined ||
    wallet.callsStatus === undefined
  ) {
    return false;
  }
  try {
    return (await wallet.capabilities(chainId)).atomic === true;
  } catch {
    return false;
  }
}

/** The chain id as EIP-1193 wants it (`0x...`). */
function chainIdHex(chain: ChainConfig): string {
  return `0x${(chain.evmChainId ?? 0).toString(16)}`;
}

/**
 * Every check that runs BEFORE anything is composed or marked, on the record
 * (not the request): nothing was requested if one fails. Returns the fee leg
 * planned from fresh terms; with a leg, the treasury must take this payer's
 * transfer and the wallet must batch.
 */
async function checkBeforeTempoPaying(
  record: OrderRecord,
  payer: string,
  fresh: ReadyOffer,
  target: TempoTarget,
  head: TempoHeadRef,
  wallet: TempoWallet,
  deps: TempoPayDeps,
): Promise<Refusal | { plan: FeePlan }> {
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
  const planned = await planFee(
    deps.feeTerms,
    target.chain.caip2,
    fresh.offer,
    { payout: recipient, payer },
    BigInt(record.amount),
  );
  if (!planned.ok) {
    return refusal(planned.reason, record);
  }
  const { plan } = planned;
  if (plan.amount > 0n) {
    // The treasury's own receive policy: a blocked fee leg would sit with the
    // guard. That is elisym's configuration, never the store's.
    const treasuryPolicy = await checkTempoReceivePolicies(deps.client, {
      chain: target.chain,
      token: target.token,
      payer,
      recipient: plan.treasury,
    });
    if (!treasuryPolicy.ok) {
      return refusal(
        treasuryPolicy.reason === 'blocked' ? 'fee_config_invalid' : 'rpc_error',
        record,
      );
    }
    if (!(await tempoWalletCanBatch(wallet, chainIdHex(target.chain)))) {
      return refusal('wallet_cannot_batch', record);
    }
  }
  const balance = await tokenBalance(deps.client, target.token, payer);
  if (balance === null) {
    return refusal('rpc_error', record);
  }
  const needed = BigInt(record.amount) + tempoFeeMargin(target.asset.decimals);
  if (balance < needed) {
    return { ...refusal('insufficient_token', record), needed, available: balance };
  }
  return { plan };
}

interface RequestReady {
  request: ParsedPaymentRequestV2;
  record: OrderRecord;
}

/**
 * The order's request, composed once right after the checks (so a refused
 * balance does not burn its window) with the fee leg `plan`, or the stored one
 * when it still pays what the record says - and carries exactly the leg planned
 * now (else `offer_changed`). `created_at` is the chain's finalized time.
 */
async function requestFor(
  record: OrderRecord,
  target: TempoTarget,
  head: TempoHeadRef,
  plan: FeePlan,
  deps: TempoPayDeps,
): Promise<RequestReady | Refusal> {
  if (record.paymentRequest !== undefined) {
    const stored = storedTempoRequest(record);
    if (stored === undefined || !tempoRequestMatches(stored, record, target)) {
      return refusal('not_payable', record);
    }
    if (!sameFeePlan(storedFeePlan(stored), plan)) {
      return refusal('offer_changed', record);
    }
    return { request: stored, record };
  }
  const recipient = record.payout.address.toLowerCase();
  let request: ParsedPaymentRequestV2;
  try {
    request = composeTempoPaymentRequest({
      chain: target.chain,
      asset: target.asset,
      recipient,
      amount: BigInt(record.amount),
      feeAmount: plan.amount,
      // Only read at a fee above zero.
      treasury: plan.amount > 0n ? plan.treasury : recipient,
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

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function isUserRejection(error: unknown): boolean {
  return errorCode(error) === 4001;
}

/**
 * EIP-5792 answers to `wallet_sendCalls` that prove nothing was signed:
 * `4001` (the buyer declined) and `5750` (the buyer declined the account
 * upgrade the batch needs) end the order like a declined transaction.
 */
const BATCH_DECLINED_CODES: readonly unknown[] = [4001, 5750];
/**
 * Answers that come before any prompt: the method, the chain, atomic
 * execution or the batch is not supported (`4200`, `5700`, `5710`, `5740`,
 * `5760`). Nothing was requested: the order is `ordered` again.
 */
const BATCH_UNSUPPORTED_CODES: readonly unknown[] = [4200, 5700, 5710, 5740, 5760];
/** A bundle id longer than this is not one (EIP-5792 caps it at 8192 bytes). */
const MAX_BUNDLE_ID_LENGTH = 8192;

/** Store the bundle id of attempt `attemptId` (with the wallet that approved it), re-reading on a lost compare-and-swap. */
async function saveTempoBundle(
  record: OrderRecord,
  attemptId: string,
  bundleId: string,
  bundleWallet: string | undefined,
  deps: Pick<TempoPayDeps, 'store'>,
): Promise<{ saved: boolean; record: OrderRecord }> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    const marker = current.marker;
    if (marker?.rail !== 'tempo' || marker.attemptId !== attemptId) {
      return { saved: false, record: current };
    }
    if (marker.bundleId === bundleId) {
      return { saved: true, record: current };
    }
    const written = await deps.store.updateMarker(current.orderId, current.version, attemptId, {
      ...marker,
      bundleId,
      ...(bundleWallet === undefined ? {} : { bundleWallet }),
    });
    if (written.ok) {
      return { saved: true, record: written.record };
    }
    if (written.reason === 'not_ready') {
      return { saved: false, record: current };
    }
    current = await deps.store.get(record.orderId);
  }
  return { saved: false, record: current ?? record };
}

/** Put a marker that requested nothing back to `ordered` (the wallet answered before any prompt). */
async function clearNotRequested(
  record: OrderRecord,
  attemptId: string,
  reason: TempoPayRefusal,
  deps: TempoPayDeps,
): Promise<Refusal> {
  const cleared = await deps.store.clearMarker(
    record.orderId,
    record.version,
    attemptId,
    'ordered',
  );
  return refusal(reason, cleared.ok ? cleared.record : record);
}

/**
 * Pay an acknowledged order: checks, the request, the pay floor, the marker
 * (test-and-set with the product exclusion and the old-prompt confirmation),
 * the wallet's chain re-read, then ONE `eth_sendTransaction` with no fee leg,
 * or ONE atomic `wallet_sendCalls` of both legs with one. A proving rejection
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
  const checked = await checkBeforeTempoPaying(record, payer, fresh, target, head, wallet, deps);
  if ('ok' in checked) {
    return checked;
  }
  const composed = await requestFor(record, target, head, checked.plan, deps);
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
  // One call with no fee leg; both legs, in one batch, with one (the wallet's
  // batching was checked with the plan, before anything was composed).
  const batched = calls.fee !== undefined;
  const call = calls.calls[0];
  if (call === undefined || calls.calls.length !== (batched ? 2 : 1)) {
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
    return clearNotRequested(current, attemptId, 'wrong_chain', deps);
  }
  if (batched) {
    return sendBatch(current, attemptId, wallet, payer, calls, deps);
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

/**
 * Send both legs as ONE atomic `wallet_sendCalls` for the attempt `attemptId`
 * (marker set). The bundle id is stored with the wallet that approved it; it
 * holds the order like a sent hash until a hash arrives or the wallet reports
 * the bundle failed.
 */
async function sendBatch(
  record: OrderRecord,
  attemptId: string,
  wallet: TempoWallet,
  payer: string,
  calls: ReturnType<typeof buildTempoPaymentCalls>,
  deps: TempoPayDeps,
): Promise<TempoPayResult> {
  if (wallet.sendCalls === undefined) {
    return clearNotRequested(record, attemptId, 'wallet_cannot_batch', deps);
  }
  let answer: { bundleId: string };
  try {
    answer = await wallet.sendCalls({
      from: payer,
      chainId: calls.chainId,
      calls: calls.calls.map((call) => ({ to: call.to, data: call.data })),
    });
  } catch (error) {
    const code = errorCode(error);
    if (BATCH_DECLINED_CODES.includes(code)) {
      return await endRejected(record, attemptId, deps);
    }
    if (BATCH_UNSUPPORTED_CODES.includes(code)) {
      return clearNotRequested(record, attemptId, 'wallet_cannot_batch', deps);
    }
    return refusal('wallet_failed', record);
  }
  const bundleId = answer?.bundleId;
  if (
    typeof bundleId !== 'string' ||
    bundleId.length === 0 ||
    bundleId.length > MAX_BUNDLE_ID_LENGTH
  ) {
    return refusal('wallet_failed', record);
  }
  const saved = await saveTempoBundle(record, attemptId, bundleId, wallet.rdns, deps);
  if (!saved.saved) {
    return { ok: true, record: saved.record, bundleId, bundleUnsaved: true };
  }
  return { ok: true, record: saved.record, bundleId };
}

export type TempoBundleStep =
  /** `100`: still pending - the watch counts the call as live (`callPending`). */
  | { step: 'pending'; record: OrderRecord }
  /** `200`, atomic, one receipt: its hash, stored (and receipted) unless `hashUnsaved`. */
  | { step: 'hash'; record: OrderRecord; hash: string; hashUnsaved?: boolean }
  /** An answer no verdict rests on (`200` non-atomic or with several receipts, `600`): the marker is kept. */
  | { step: 'unsure'; record: OrderRecord }
  /**
   * `400` / `500`: the wallet's final word that this bundle did not go
   * through. A STORED bundle is marked `bundleFailed`; an unsaved or late one
   * is simply no longer held.
   */
  | { step: 'failed'; record: OrderRecord }
  /** No wallet to ask, the bundle unknown to it (`5730`), or no answer: nothing changes. */
  | { step: 'unknown'; record: OrderRecord };

/** Mark the stored bundle `bundleId` failed, re-reading on a lost compare-and-swap. */
async function saveBundleFailed(
  record: OrderRecord,
  bundleId: string,
  deps: Pick<TempoPayDeps, 'store'>,
): Promise<OrderRecord> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    const marker = current.marker;
    if (
      marker?.rail !== 'tempo' ||
      marker.bundleId !== bundleId ||
      marker.txHash !== undefined ||
      marker.bundleFailed === true
    ) {
      return current;
    }
    const written = await deps.store.updateMarker(
      current.orderId,
      current.version,
      marker.attemptId,
      { ...marker, bundleFailed: true },
    );
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

/**
 * One look at a bundle this order's attempt sent: `wallet_getCallsStatus`
 * through `wallet` (the one that approved it), and one step of what follows -
 * see `TempoBundleStep`. A hash goes the existing way (`saveTempoHash`, then
 * the receipt); a bundle never becomes `paid` by itself.
 */
export async function followTempoBundle(
  record: OrderRecord,
  deps: Pick<TempoPayDeps, 'store' | 'readClient' | 'clientFor' | 'now'>,
  wallet: Pick<TempoWallet, 'callsStatus'> | undefined,
  bundleId: string,
): Promise<TempoBundleStep> {
  const marker = record.marker;
  // Only this attempt's bundle: a stored one must be the one asked about.
  if (
    marker?.rail !== 'tempo' ||
    (marker.bundleId !== undefined && marker.bundleId !== bundleId) ||
    wallet?.callsStatus === undefined
  ) {
    return { step: 'unknown', record };
  }
  let status: CallsStatus;
  try {
    status = await wallet.callsStatus(bundleId);
  } catch {
    return { step: 'unknown', record };
  }
  switch (status?.status) {
    case 100:
      return { step: 'pending', record };
    case 200: {
      const receipts = Array.isArray(status.receipts) ? status.receipts : [];
      const only = receipts.length === 1 ? receipts[0] : undefined;
      const hash = status.atomic === true ? readTxHash(only?.transactionHash) : null;
      if (hash === null) {
        return { step: 'unsure', record };
      }
      const saved = await saveTempoHash(record, marker.attemptId, hash, deps);
      if (!saved.saved) {
        return { step: 'hash', record: saved.record, hash, hashUnsaved: true };
      }
      const receipt = await sendReceipt(saved.record, hash, (deps.now ?? nowSecs)(), deps);
      return { step: 'hash', record: receipt.ok ? receipt.record : saved.record, hash };
    }
    case 400:
    case 500:
      return {
        step: 'failed',
        record:
          marker.bundleId === bundleId ? await saveBundleFailed(record, bundleId, deps) : record,
      };
    case 600:
      return { step: 'unsure', record };
    default:
      return { step: 'unknown', record };
  }
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
  /**
   * Nothing holds the order (no hash, no pending call, no bundle that has not failed) and
   * either a vouched "not paid" came past the late deadline, or a payment the
   * merchant node could only have credited during its catch-up (a split it
   * cannot resolve) is still all there is once that catch-up is over.
   */
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
  /**
   * A bundle id returned in this session that is not stored on the marker (its
   * write failed, or it came after a close): it holds the order like a stored,
   * bundle that has not failed.
   */
  pendingBundleId?: string;
}

async function recordTempoPaid(
  record: OrderRecord,
  hash: string,
  deps: TempoWatchDeps,
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

async function recordBlocked(record: OrderRecord, deps: TempoWatchDeps): Promise<OrderRecord> {
  const written = await deps.store.update(record.orderId, record.version, { state: 'blocked' });
  return written.ok ? written.record : record;
}

/**
 * The lowest payee leg the merchant node may still credit for `amount`: the
 * price less a fee at `MAX_FEE_BPS` (its 10% floor). 0 for a 1-subunit price.
 */
export function merchantFloor(amount: bigint): bigint {
  return amount - calculateProtocolFeeSubunits(amount, MAX_FEE_BPS);
}

/** `request` with no fee leg and a total of `amount`: the derived questions the watch asks again. */
function derivedRequest(request: ParsedPaymentRequestV2, amount: bigint): ParsedPaymentRequestV2 {
  const { fee_address: _feeAddress, fee_amount: _feeAmount, ...rest } = request;
  return { ...rest, amount: amount.toString() };
}

/**
 * Whether a verified result is a payment the merchant node credits: the
 * payee's leg alone reaches the price (its rule 1, whatever the fee leg), or
 * there is no fee leg to judge, or the fee leg is in the payee leg's own
 * transaction (its rule 2). A split across two transactions it never credits.
 */
function creditedByNode(
  result: Extract<Awaited<ReturnType<typeof verifyTempoPayment>>, { outcome: 'verified' }>,
  request: ParsedPaymentRequestV2,
): boolean {
  return (
    result.providerLeg.amount >= BigInt(request.amount) ||
    result.feeLeg === undefined ||
    result.feeLeg.transactionHash === result.providerLeg.transactionHash
  );
}

/**
 * One reconciliation step for a Tempo attempt, or for a Tempo order that ended
 * `over` (its prompt can still be approved). It mirrors the merchant node's
 * paid rule by asking the verifier again on derived requests:
 * - a verified payment the node credits is `paid`; a fee leg in another
 *   transaction, or a payee leg without its fee leg (`fee_leg_*`), is paid only
 *   when the same memo also carries the WHOLE price to the payee (the fee-less
 *   request); otherwise it is held (`unsure`) - its transaction is never stored;
 * - `none` while the merchant's catch-up is open is asked again at the node's
 *   floor (`merchantFloor`, skipped at 0): any leg there holds the order;
 * - a held split ends `over` once the catch-up is over and nothing else holds
 *   the order (no hash, no live call, no bundle that has not failed) - by then the node
 *   has dropped it. The other way to `over` is `none` past the late deadline,
 *   vouched by the verifier, with nothing holding the order.
 * Every derived question uses the watch's own options (`pollBudgetMs: 0`).
 */
export async function watchTempoPayment(
  record: OrderRecord,
  deps: TempoWatchDeps,
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
  const marker: TempoMarker = current.marker?.rail === 'tempo' ? current.marker : record.marker;
  const hash = marker.txHash ?? options.pendingHash;
  const verifyOptions = {
    ...(hash === undefined ? {} : { txSignature: hash }),
    fromBlock: Number(marker.floorBlock),
    pollBudgetMs: 0,
  };
  const held =
    hash !== undefined ||
    options.callPending === true ||
    (marker.bundleId !== undefined && marker.bundleFailed !== true) ||
    options.pendingBundleId !== undefined;
  const catchUpOpen =
    (deps.now ?? nowSecs)() - current.createdAt <= MERCHANT_CATCH_UP_SECS + MAX_CLOCK_SKEW_SECS;
  // A split the node may credit: held while it can, then released like `none`.
  const splitHeld = (): TempoWatch =>
    !held && !catchUpOpen && current.state === 'paying'
      ? { state: 'over', record: current }
      : { state: 'unsure', record: current };
  // The whole price to the payee under this memo, whatever the fee leg (node rule 1).
  const fullPrice = async (): Promise<TempoWatch> => {
    const full = await verifyTempoPayment(
      deps.client,
      derivedRequest(request, BigInt(request.amount)),
      verifyOptions,
    );
    return full.outcome === 'verified'
      ? {
          state: 'paid',
          record: await recordTempoPaid(current, full.providerLeg.transactionHash, deps),
        }
      : splitHeld();
  };
  const result = await verifyTempoPayment(deps.client, request, verifyOptions);
  switch (result.outcome) {
    case 'verified':
      if (creditedByNode(result, request)) {
        return {
          state: 'paid',
          record: await recordTempoPaid(current, result.providerLeg.transactionHash, deps),
        };
      }
      return fullPrice();
    case 'none': {
      const floor = merchantFloor(BigInt(request.amount));
      if (catchUpOpen && floor > 0n) {
        const atFloor = await verifyTempoPayment(
          deps.client,
          derivedRequest(request, floor),
          verifyOptions,
        );
        if (atFloor.outcome !== 'none') {
          return { state: 'unsure', record: current };
        }
      }
      if (!held && current.state === 'paying') {
        return { state: 'over', record: current };
      }
      return { state: 'waiting', record: current, pastDeadline: hash !== undefined };
    }
    case 'refused':
      switch (result.code) {
        case 'provider_leg_blocked':
          return { state: 'blocked', record: await recordBlocked(current, deps) };
        case 'fee_leg_missing':
        case 'fee_leg_blocked':
          return fullPrice();
        case 'wrong_chain':
        case 'unknown_asset':
        case 'unreadable_receipt':
        case 'reverted':
        case 'no_provider_leg':
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
  deps: TempoWatchDeps,
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
