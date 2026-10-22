/**
 * Paying an acknowledged order with USDC over EIP-3009 (Ethereum, Arbitrum,
 * Base), following it, and ending it.
 *
 * The buyer signs a `transferWithAuthorization` whose nonce is the order's
 * reference, then sends it from the same wallet and pays the gas. USDC lets one
 * `(authorizer, nonce)` land at most once, ever, so a retry with the SAME
 * wallet waits for nothing; another wallet is another nonce space - the one way
 * to pay an order twice - and is allowed only after the end proof: a finalized
 * block past the authorization's `validBefore` at which it was not used.
 *
 * A signature, once stored, is never cleared (`signed`): an order that ever
 * held one ends only through the end proof. A stored signature is evidence for
 * the store rules only: a send uses the typed data and signature the attempt
 * that signed holds in memory.
 */
import { type Asset, type ChainConfig, settlementOf } from '@elisym/pay-core';
import {
  type Eip1193Client,
  type Eip3009BlockRef,
  type TransferAuthorizationTypedData,
  buildTransferAuthorization,
  checkEvmChain,
  encodeTransferWithAuthorization,
  estimateTransferWithAuthorization,
  listAuthorizationsByNonce,
  normalizeAuthorizationSignature,
  readAuthorizationCanceled,
  readAuthorizationUsed,
  readBlockAtTag,
  readEip3009Legs,
  readEip3009Preflight,
  readFinalizedBlockWithHash,
  readL1Fee,
  readQuantity,
  readTxHash,
} from '@elisym/pay-core/evm';
import { parseCaip19 } from '../caip';
import { deriveOrderPaymentReference } from '../orders/payment-reference';
import { isOfferPayout } from '../verify-offer';
import {
  EIP3009_GAS_MARGIN_BPS,
  EIP3009_PAY_CUTOFF_SECS,
  EIP3009_VALID_SECS,
  MERCHANT_CATCH_UP_SECS,
  SEND_MARGIN_SECS,
  STORE_WRITE_ATTEMPTS,
} from './constants';
import { nowSecs } from './events';
import { type FeeRefusal, type FeeTermsSource, feeRefusalOf } from './fee';
import { type LoadedOffer, isSnapshotStale } from './offer';
import { type OrderDeps, sendReceipt } from './order-flow';
import {
  type Eip3009Proof,
  type OrderRecord,
  type PaymentMarker,
  isTerminal,
} from './order-record';
import { type StoreWrite, storeClosed } from './order-store';

type Eip3009Marker = Extract<PaymentMarker, { rail: 'eip3009' }>;

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const BPS_DENOMINATOR = 10_000n;
/** EIP-1193: the buyer declined. */
const USER_REJECTED = 4001;
/** EIP-1193 (MetaMask): a request of this kind is already open in the wallet. */
const WALLET_BUSY = -32002;

export interface Eip3009PayDeps extends OrderDeps {
  /**
   * The widget's own RPC of the record's chain: the step 2 reads, the gas
   * estimate, receipts, scans and the end proof. A failed read is never "not paid".
   */
  client: Eip1193Client;
  /** The device clock (seconds): the marker's `setAt`, the receipt's date. */
  now?: () => number;
  newAttemptId?: () => string;
  /** The protocol fee terms of a chain, read fresh: this rail pays only at fee 0 (E7). */
  feeTerms: FeeTermsSource;
}

/** What following and ending an attempt needs: no fee terms (nothing is composed or signed). */
export type Eip3009WatchDeps = Omit<Eip3009PayDeps, 'feeTerms'>;

/** An EIP-1193 wallet, reduced to what one payment needs. */
export interface Eip3009Wallet {
  /** `eth_requestAccounts`: the first account is the payer. Rejects with the wallet's error. */
  requestAccounts(): Promise<readonly string[]>;
  /**
   * `wallet_switchEthereumChain` to `chain`, adding it from the registry
   * (`chainName`, `nativeCurrency`) when the wallet does not know it (4902).
   * Rejects with the wallet's error. An "ok" proves nothing: the chain id is
   * read afterwards.
   */
  switchChain(chain: ChainConfig): Promise<void>;
  /** `eth_chainId` as the WALLET answers it. */
  chainId(): Promise<number>;
  /** `eth_signTypedData_v4(address, typedData)`; a refusal rejects with `code: 4001`. */
  signTypedData(address: string, typedData: string): Promise<string>;
  /** `eth_sendTransaction` of one call; resolves the hash. A refusal rejects with `code: 4001`. */
  sendTransaction(call: {
    from: string;
    to: string;
    data: string;
    chainId: string;
  }): Promise<string>;
}

/** How a wallet answered a connect, as `connectProblem` in the checkout reads it. */
export type Eip3009WalletError = 'rejected' | 'busy' | 'failed';

export type Eip3009PayRefusal =
  /** The record cannot take a payment now (state, request, the store closed it). */
  | 'not_payable'
  /** Step 1: the wallet declined, was busy or is not there (`walletError`). */
  | 'connect_failed'
  /** The offer snapshot is older than two minutes: verify again. */
  | 'stale_offer'
  /** The store no longer offers this payout at this price. */
  | 'offer_changed'
  /** Too close to the merchant's catch-up end (`EIP3009_PAY_CUTOFF_SECS`). */
  | 'too_late'
  | 'self_payment'
  /** USDC below the price (`needed` / `available`, subunits). */
  | 'insufficient_token'
  /** No native coin for gas at all (no amounts: the full check needs the signature). */
  | 'no_native'
  /** USDC is paused, or the payer or the payee is blacklisted. */
  | 'token_blocked'
  /** The USDC domain separator or implementation is not the one the registry pins. */
  | 'unpayable'
  /** The payer's code is neither none nor a 7702 delegation to a known delegate. */
  | 'payer_unsupported'
  /** The wallet cannot reach the chain, or the widget RPC answers for another. */
  | 'wrong_chain'
  /** A chain read failed; nothing was requested (before the marker) or sent. */
  | 'rpc_error'
  | 'exclusion'
  | 'needs_confirmation'
  /** The record changed meanwhile; after a signature: it was not written, nothing was sent. */
  | 'conflict'
  /** E7: this rail pays only at a protocol fee of 0; the checkout does not offer it otherwise. */
  | 'fee_not_zero'
  /** The typed-data prompt was refused and nothing was ever signed: the order is `ordered` again. */
  | 'rejected'
  /** A first signature failed or does not recover: nothing stored, the order is `ordered` again. */
  | 'sign_failed'
  /** A retry's typed-data prompt was refused, or its signature does not recover: the attempt stays. */
  | 'sign_declined'
  /** Step 5.1: the native coin may not cover the gas (`needed` / `available`, wei); `resend` sends anyway. */
  | 'insufficient_native'
  /** Step 6: the wallet is on another chain after signing; `resend` switches back and sends. */
  | 'wrong_chain_after_sign'
  /** Step 6: too close to `validBefore` to send: sign again (a retry). */
  | 'resign_needed'
  /** The send prompt was refused (4001); `resend` asks again with the same signature. */
  | 'send_declined'
  /** The wallet returned no hash: check the wallet; the attempt stays. */
  | 'wallet_failed'
  /** Step 5.1: the estimate failed and the nonce is unused: nothing was sent, retry. */
  | 'send_failed'
  /** A retry from another account than the marker's: that is a switch (the end proof first). */
  | 'other_payer'
  /** The nonce was already used when a FIRST attempt read it: the order is frozen (`usedAtStart`). */
  | 'nonce_used'
  /** An earlier transaction may have landed: watch it, ask nothing. */
  | 'still_waiting'
  | FeeRefusal;

/**
 * A signed attempt whose send can be asked again with the signature still in
 * memory: after `insufficient_native` ("send anyway"), `wrong_chain_after_sign`
 * (switch back) or `send_declined`. Frozen and never persisted.
 */
export interface Eip3009Resend {
  readonly orderId: string;
  readonly attemptId: string;
}

export type Eip3009PayResult =
  | {
      ok: true;
      record: OrderRecord;
      hash: string;
      /** The hash could not be stored yet: keep it in memory and pass it to the watch. */
      hashUnsaved?: true;
      /** The send came close to `validBefore`: it may land as an expired revert. */
      nearExpiry?: true;
    }
  | {
      ok: false;
      reason: Eip3009PayRefusal;
      record?: OrderRecord;
      holder?: string;
      unconfirmed?: string[];
      /** For `insufficient_token` (subunits) and `insufficient_native` (wei). */
      needed?: bigint;
      available?: bigint;
      /** For `connect_failed`. */
      walletError?: Eip3009WalletError;
      /** The refusal came while a signed marker exists: follow the attempt, never end the order by it. */
      afterMarker?: true;
      attemptId?: string;
      /** For `insufficient_native`, `wrong_chain_after_sign`, `send_declined` and `rpc_error` at step 6. */
      resend?: Eip3009Resend;
      /** The signature was made but its write was refused, so nothing was sent (as Solana's). */
      signedNotSent?: true;
      /** For a switch that waits: what the end proof said (`too_early` or `used`). */
      proof?: Eip3009EndProofState;
    };

type Refusal = Extract<Eip3009PayResult, { ok: false }>;

interface Eip3009Target {
  chain: ChainConfig;
  asset: Asset;
  /** The USDC proxy, lowercase. */
  token: string;
  /** The payout address, lowercase. */
  payee: string;
  /** The order's nonce: the record's reference, which must be the derived one. */
  nonce: string;
  amount: bigint;
}

/**
 * The chain, coin, payee, nonce and price of an `eip3009` record, or
 * `undefined`: the reference must be the nonce DERIVED from the order (a
 * nonce the node never derives is paid, never credited).
 */
function eip3009TargetOf(record: OrderRecord): Eip3009Target | undefined {
  const caip19 = parseCaip19(record.payout.caip19);
  const mint = caip19?.asset.mint;
  if (caip19 === undefined || settlementOf(caip19.chain) !== 'eip3009' || mint === undefined) {
    return undefined;
  }
  let derived: string;
  try {
    derived = deriveOrderPaymentReference({
      storePubkey: record.storePubkey,
      buyerPubkey: record.buyerPubkey,
      orderId: record.orderId,
    }).eip3009;
  } catch {
    return undefined;
  }
  const payee = record.payout.address.toLowerCase();
  if (
    derived !== record.reference ||
    !EVM_ADDRESS_RE.test(payee) ||
    !/^[1-9][0-9]*$/.test(record.amount)
  ) {
    return undefined;
  }
  return {
    chain: caip19.chain,
    asset: caip19.asset,
    token: mint.toLowerCase(),
    payee,
    nonce: record.reference,
    amount: BigInt(record.amount),
  };
}

/**
 * A marker every read and write below can rest on: the authorizer an address,
 * the floor and `validBefore` decimal, a stored hash 32 bytes of lowercase hex.
 * A record is caller-supplied: a malformed marker is refused, never read.
 */
function wellFormedMarker(marker: Eip3009Marker): boolean {
  return (
    EVM_ADDRESS_RE.test(marker.authorizer) &&
    DECIMAL_RE.test(marker.floorBlock) &&
    Number.isSafeInteger(Number(marker.floorBlock)) &&
    DECIMAL_RE.test(marker.validBefore) &&
    (marker.txHash === undefined || readTxHash(marker.txHash) === marker.txHash)
  );
}

/** What does not change across the attempts of an order; `validBefore` is not in it. */
export interface Eip3009PaymentRequest {
  rail: 'eip3009';
  caip2: string;
  caip19: string;
  payee: string;
  /** Subunits, decimal. */
  amount: string;
  nonce: string;
}

function composedRequest(record: OrderRecord, target: Eip3009Target): Eip3009PaymentRequest {
  return {
    rail: 'eip3009',
    caip2: target.chain.caip2,
    caip19: record.payout.caip19,
    payee: target.payee,
    amount: target.amount.toString(),
    nonce: target.nonce,
  };
}

/**
 * The request stored on the record, or `undefined` when there is none or it
 * pays anything else than the record's payout, amount and reference.
 */
export function storedEip3009Request(record: OrderRecord): Eip3009PaymentRequest | undefined {
  const target = eip3009TargetOf(record);
  if (record.paymentRequest === undefined || target === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.paymentRequest);
  } catch {
    return undefined;
  }
  const expected = composedRequest(record, target);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const keys = Object.keys(expected) as (keyof Eip3009PaymentRequest)[];
  const matches =
    Object.keys(parsed).length === keys.length &&
    keys.every((key) => Reflect.get(parsed, key) === expected[key]);
  return matches ? expected : undefined;
}

/** The chain's time, from its LATEST block: what an order on this rail is dated with. */
export async function readEip3009ChainTime(client: Eip1193Client): Promise<number> {
  const latest = await readBlockAtTag(client, 'latest');
  if (latest === null) {
    throw new Error('The chain could not be read.');
  }
  return latest.timestamp;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function walletErrorOf(error: unknown): Eip3009WalletError {
  const code = errorCode(error);
  if (code === USER_REJECTED) {
    return 'rejected';
  }
  return code === WALLET_BUSY ? 'busy' : 'failed';
}

/**
 * Every refusal is built here, and whether it leaves an attempt live is read
 * from the RECORD it returns: a `paying` record whose `eip3009` marker holds a
 * signature (not the frozen `usedAtStart` one) keeps that attempt live, since
 * the signature can still land; no return site decides it on its own, and no
 * caller adds `afterMarker` or `attemptId` to a refusal after it is built.
 */
function refusal(
  reason: Eip3009PayRefusal,
  record?: OrderRecord,
  flags: { signedNotSent?: true } = {},
): Refusal {
  const extra = flags.signedNotSent === true ? { signedNotSent: true as const } : {};
  if (record === undefined) {
    return { ok: false, reason, ...extra };
  }
  const marker = record.marker;
  if (
    record.state === 'paying' &&
    marker?.rail === 'eip3009' &&
    marker.signed === true &&
    marker.usedAtStart !== true &&
    wellFormedMarker(marker)
  ) {
    return { ok: false, reason, record, afterMarker: true, attemptId: marker.attemptId, ...extra };
  }
  return { ok: false, reason, record, ...extra };
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

function chainIdHex(chain: ChainConfig): string {
  return `0x${(chain.evmChainId ?? 0).toString(16)}`;
}

type Connected =
  | { ok: true; payer: string }
  | { ok: false; reason: 'connect_failed'; walletError: Eip3009WalletError }
  | { ok: false; reason: 'wrong_chain' };

/**
 * Step 1: the account, the switch to the payout's chain, then the wallet's own
 * `eth_chainId` - a switch that answers "ok" proves nothing. A declined or busy
 * wallet, or none, is reported raw; any other switch error, or a chain id that
 * is still another one, is `wrong_chain`.
 */
async function connect(wallet: Eip3009Wallet, chain: ChainConfig): Promise<Connected> {
  let accounts: readonly string[];
  try {
    accounts = await wallet.requestAccounts();
  } catch (error) {
    return { ok: false, reason: 'connect_failed', walletError: walletErrorOf(error) };
  }
  const first = accounts[0];
  const payer = typeof first === 'string' ? first.toLowerCase() : '';
  if (!EVM_ADDRESS_RE.test(payer)) {
    return { ok: false, reason: 'connect_failed', walletError: 'failed' };
  }
  try {
    await wallet.switchChain(chain);
  } catch (error) {
    const kind = walletErrorOf(error);
    return kind === 'failed'
      ? { ok: false, reason: 'wrong_chain' }
      : { ok: false, reason: 'connect_failed', walletError: kind };
  }
  const named = await wallet.chainId().catch(() => undefined);
  if (named !== chain.evmChainId) {
    return { ok: false, reason: 'wrong_chain' };
  }
  return { ok: true, payer };
}

function connectRefusal(connected: Exclude<Connected, { ok: true }>, record: OrderRecord): Refusal {
  return connected.reason === 'connect_failed'
    ? { ...refusal('connect_failed', record), walletError: connected.walletError }
    : refusal('wrong_chain', record);
}

type Checked = { ok: true; latest: Eip3009BlockRef } | Refusal;

/**
 * Step 2, on the record (first attempt, retry and switch alike). FIRST the
 * widget RPC's chain and `authorizationState(payer, nonce)` at `latest`: true
 * is `nonce_used` on a first attempt and `still_waiting` on a retry or switch,
 * whatever the other checks would say. Then the fresh offer, fee 0, the payer,
 * the cutoff on chain time, and the USDC and payer state.
 */
async function checkBeforeEip3009(
  record: OrderRecord,
  target: Eip3009Target,
  payer: string,
  fresh: ReadyOffer,
  attempt: 'first' | 'again',
  deps: Eip3009PayDeps,
): Promise<Checked> {
  const { client } = deps;
  const named = await checkEvmChain(client, target.chain).catch(() => 'wrong' as const);
  if (named === 'wrong') {
    return refusal('wrong_chain', record);
  }
  if (named === null) {
    return refusal('rpc_error', record);
  }
  const used = await readAuthorizationUsed(
    client,
    target.chain,
    target.asset,
    payer,
    target.nonce,
    'latest',
  );
  if (used === 'unreadable') {
    return refusal('rpc_error', record);
  }
  if (used === 'used') {
    return refusal(attempt === 'first' ? 'nonce_used' : 'still_waiting', record);
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
    match.amount !== target.amount
  ) {
    return refusal('offer_changed', record);
  }
  let feeBps: number;
  try {
    feeBps = (await deps.feeTerms(target.chain.caip2)).feeBps;
  } catch (error) {
    return refusal(feeRefusalOf(error), record);
  }
  if (feeBps !== 0) {
    return refusal('fee_not_zero', record);
  }
  if (payer === target.payee) {
    return refusal('self_payment', record);
  }
  const latest = await readBlockAtTag(client, 'latest');
  if (latest === null) {
    return refusal('rpc_error', record);
  }
  if (latest.timestamp > record.createdAt + MERCHANT_CATCH_UP_SECS - EIP3009_PAY_CUTOFF_SECS) {
    return refusal('too_late', record);
  }
  const chainState = await readEip3009Preflight(
    client,
    target.chain,
    target.asset,
    payer,
    target.payee,
  );
  if (!chainState.ok) {
    return refusal('rpc_error', record);
  }
  if (!chainState.domainMatches || !chainState.implementationMatches) {
    return refusal('unpayable', record);
  }
  if (chainState.paused || chainState.payerBlacklisted || chainState.payeeBlacklisted) {
    return refusal('token_blocked', record);
  }
  if (chainState.tokenBalance < target.amount) {
    return {
      ...refusal('insufficient_token', record),
      needed: target.amount,
      available: chainState.tokenBalance,
    };
  }
  if (chainState.nativeBalance === 0n) {
    return refusal('no_native', record);
  }
  const code = chainState.payerCode;
  if (code.kind === 'other' || (code.kind === 'delegated' && !code.known)) {
    return refusal('payer_unsupported', record);
  }
  return { ok: true, latest };
}

/**
 * Step 3: the request, written once while `ordered` (re-read on a lost
 * compare-and-swap), or the stored one when it pays what the record says.
 */
async function writeRequest(
  record: OrderRecord,
  target: Eip3009Target,
  deps: Pick<Eip3009PayDeps, 'store'>,
): Promise<{ record: OrderRecord } | Refusal> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.paymentRequest !== undefined) {
      return storedEip3009Request(current) === undefined
        ? refusal('not_payable', current)
        : { record: current };
    }
    const written = await deps.store.update(current.orderId, current.version, {
      paymentRequest: JSON.stringify(composedRequest(current, target)),
    });
    if (written.ok) {
      return { record: written.record };
    }
    if (written.reason !== 'conflict') {
      return storeRefusal(written, current);
    }
    current = await deps.store.get(record.orderId);
  }
  return refusal('conflict', current ?? record);
}

function newAttemptId(deps: Pick<Eip3009PayDeps, 'newAttemptId'>): string {
  return (deps.newAttemptId ?? (() => crypto.randomUUID()))();
}

/**
 * A first attempt whose nonce reads used: the request is written, then a
 * FROZEN marker (`usedAtStart`, `signed`, `validBefore` "0") that the store
 * keeps from every later marker write - no end proof is sound for an
 * authorization whose `validBefore` is unknown. `nonce_used`, unless the record
 * turns out to hold another tab's attempt already: that one is followed
 * (`still_waiting`), never frozen over.
 */
async function freezeUsedAtStart(
  record: OrderRecord,
  target: Eip3009Target,
  payer: string,
  deps: Eip3009PayDeps,
): Promise<Refusal> {
  const composed = await writeRequest(record, target, deps);
  if ('ok' in composed) {
    const used = refusal('nonce_used', composed.record);
    return composed.holder === undefined ? used : { ...used, holder: composed.holder };
  }
  const finalized = await readFinalizedBlockWithHash(deps.client);
  if (finalized === null) {
    return usedAnswer(composed.record);
  }
  const now = (deps.now ?? nowSecs)();
  const marker: Eip3009Marker = {
    rail: 'eip3009',
    attemptId: newAttemptId(deps),
    setAt: now,
    usedAtStart: true,
    authorizer: payer,
    floorBlock: String(finalized.number),
    validBefore: '0',
    signed: true,
  };
  let current: OrderRecord | undefined = composed.record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.state !== 'ordered' || current.marker !== undefined) {
      break;
    }
    const marked = await deps.store.setMarker(current.orderId, current.version, marker, now);
    if (marked.ok) {
      return refusal('nonce_used', marked.record);
    }
    if (marked.reason !== 'conflict') {
      return {
        ...refusal('nonce_used', current),
        ...(marked.holder === undefined ? {} : { holder: marked.holder }),
      };
    }
    current = await deps.store.get(record.orderId);
  }
  return usedAnswer(current ?? composed.record);
}

/**
 * `nonce_used` for a record with no attempt of its own (or the frozen one);
 * `still_waiting` when another tab's attempt is already on it: its own
 * authorization may be what landed, so it is followed, not frozen.
 */
function usedAnswer(record: OrderRecord): Refusal {
  const marker = record.marker;
  return marker !== undefined && !(marker.rail === 'eip3009' && marker.usedAtStart === true)
    ? refusal('still_waiting', record)
    : refusal('nonce_used', record);
}

/**
 * Pay an acknowledged order (`ordered`, no marker): connect, the step 2
 * checks, the request, the marker (test-and-set with the product exclusion),
 * then the typed-data prompt with exactly the marker's `validBefore`, the
 * signature stored with `signed`, the gas check, and the send.
 */
export async function payWithEip3009(
  record: OrderRecord,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  const target = eip3009TargetOf(record);
  if (
    target === undefined ||
    record.state !== 'ordered' ||
    record.marker !== undefined ||
    storeClosed(record) ||
    (record.paymentRequest !== undefined && storedEip3009Request(record) === undefined)
  ) {
    return refusal('not_payable', record);
  }
  const connected = await connect(wallet, target.chain);
  if (!connected.ok) {
    return connectRefusal(connected, record);
  }
  return firstAttempt(record, target, connected.payer, wallet, fresh, deps);
}

async function firstAttempt(
  record: OrderRecord,
  target: Eip3009Target,
  payer: string,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  const checked = await checkBeforeEip3009(record, target, payer, fresh, 'first', deps);
  if (!checked.ok) {
    return checked.reason === 'nonce_used'
      ? await freezeUsedAtStart(record, target, payer, deps)
      : checked;
  }
  const composed = await writeRequest(record, target, deps);
  if ('ok' in composed) {
    return composed;
  }
  const finalized = await readFinalizedBlockWithHash(deps.client);
  if (finalized === null) {
    return refusal('rpc_error', composed.record);
  }
  const validBefore = BigInt(checked.latest.timestamp) + BigInt(EIP3009_VALID_SECS);
  const typed = typedDataFor(target, payer, validBefore);
  if (typed === undefined) {
    return refusal('unpayable', composed.record);
  }
  const now = (deps.now ?? nowSecs)();
  const marker: Eip3009Marker = {
    rail: 'eip3009',
    attemptId: newAttemptId(deps),
    setAt: now,
    authorizer: payer,
    floorBlock: String(finalized.number),
    validBefore: validBefore.toString(),
  };
  const marked = await deps.store.setMarker(
    composed.record.orderId,
    composed.record.version,
    marker,
    now,
  );
  if (!marked.ok) {
    return storeRefusal(marked, composed.record);
  }
  return signAndSend(marked.record, marker, typed, payer, wallet, target, 'first', deps);
}

function typedDataFor(
  target: Eip3009Target,
  payer: string,
  validBefore: bigint,
): TransferAuthorizationTypedData | undefined {
  try {
    return buildTransferAuthorization({
      chain: target.chain,
      asset: target.asset,
      from: payer,
      to: target.payee,
      value: target.amount,
      nonce: target.nonce,
      validBefore,
    });
  } catch {
    return undefined;
  }
}

/**
 * A marker that never held a signature asked for nothing that can land: it is
 * cleared to `ordered` (re-read on a lost compare-and-swap; never another
 * tab's attempt, handed back as `conflict`).
 */
async function clearUnsigned(
  record: OrderRecord,
  attemptId: string,
  reason: 'rejected' | 'sign_failed',
  deps: Pick<Eip3009PayDeps, 'store'>,
): Promise<Refusal> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.marker?.attemptId !== attemptId || current.state !== 'paying') {
      break;
    }
    const cleared = await deps.store.clearMarker(
      current.orderId,
      current.version,
      attemptId,
      'ordered',
    );
    if (cleared.ok) {
      return refusal(reason, cleared.record);
    }
    if (cleared.reason !== 'conflict') {
      break;
    }
    current = await deps.store.get(record.orderId);
  }
  return refusal('conflict', current ?? record);
}

/** What an attempt that signed holds in memory, and what a resend handle stands for. */
interface SignedAttempt {
  orderId: string;
  attemptId: string;
  payer: string;
  typed: TransferAuthorizationTypedData;
  signature: string;
  calldata: string;
  /**
   * Shared by every handle of the attempt: the wallet was handed the signed
   * call (whatever became of the answer), or a resend is asking it now. A
   * second send of one authorization can only revert at the buyer's gas.
   */
  sends: { inFlight: boolean; sent: boolean };
}

/** Every resend handle given out, with what it stands for: only a handle from here is honoured. */
const SIGNED_ATTEMPTS = new WeakMap<Eip3009Resend, SignedAttempt>();

function resendHandle(signed: SignedAttempt): Eip3009Resend {
  const handle: Eip3009Resend = Object.freeze({
    orderId: signed.orderId,
    attemptId: signed.attemptId,
  });
  SIGNED_ATTEMPTS.set(handle, signed);
  return handle;
}

/**
 * Store the attempt's signature with `signed`, re-reading on a lost
 * compare-and-swap while the attempt holds and its stored `validBefore` is the
 * one signed. Refused once the attempt changed (another tab cleared or
 * replaced it): nothing is sent then.
 */
async function saveSignature(
  record: OrderRecord,
  signed: SignedAttempt,
  deps: Pick<Eip3009PayDeps, 'store'>,
): Promise<{ saved: boolean; record: OrderRecord }> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    const marker = current.marker;
    if (
      current.state !== 'paying' ||
      marker?.rail !== 'eip3009' ||
      marker.attemptId !== signed.attemptId ||
      marker.authorizer !== signed.payer ||
      marker.validBefore !== signed.typed.message.validBefore
    ) {
      return { saved: false, record: current };
    }
    if (marker.signed === true && marker.signature === signed.signature) {
      return { saved: true, record: current };
    }
    const written = await deps.store.updateMarker(
      current.orderId,
      current.version,
      signed.attemptId,
      {
        ...marker,
        signed: true,
        signature: signed.signature,
      },
    );
    if (written.ok) {
      return { saved: true, record: written.record };
    }
    if (written.reason !== 'conflict') {
      return { saved: false, record: current };
    }
    current = await deps.store.get(record.orderId);
  }
  return { saved: false, record: current ?? record };
}

/**
 * Step 5: the typed-data prompt for the attempt `marker` (already set), with
 * EXACTLY its `validBefore`; the signature normalized and recovered, stored
 * with `signed` BEFORE anything is sent; then the gas check (5.1) and the send.
 */
async function signAndSend(
  record: OrderRecord,
  marker: Eip3009Marker,
  typed: TransferAuthorizationTypedData,
  payer: string,
  wallet: Eip3009Wallet,
  target: Eip3009Target,
  mode: 'first' | 'again',
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  const attemptId = marker.attemptId;
  let answered: string;
  try {
    answered = await wallet.signTypedData(payer, JSON.stringify(typed));
  } catch (error) {
    if (mode === 'again') {
      return refusal('sign_declined', record);
    }
    return await clearUnsigned(
      record,
      attemptId,
      errorCode(error) === USER_REJECTED ? 'rejected' : 'sign_failed',
      deps,
    );
  }
  const signature = normalizeAuthorizationSignature(typed, answered, payer);
  if (signature === undefined) {
    return mode === 'again'
      ? refusal('sign_declined', record)
      : await clearUnsigned(record, attemptId, 'sign_failed', deps);
  }
  let calldata: string;
  try {
    calldata = encodeTransferWithAuthorization(typed.message, signature);
  } catch {
    return mode === 'again'
      ? refusal('sign_declined', record)
      : await clearUnsigned(record, attemptId, 'sign_failed', deps);
  }
  const signed: SignedAttempt = {
    orderId: record.orderId,
    attemptId,
    payer,
    typed,
    signature,
    calldata,
    sends: { inFlight: false, sent: false },
  };
  const saved = await saveSignature(record, signed, deps);
  if (!saved.saved) {
    return refusal('conflict', saved.record, { signedNotSent: true });
  }
  const gas = await checkGas(signed, target, deps);
  if (gas.ok !== true) {
    if (gas.reason === 'insufficient_native') {
      return {
        ...refusal('insufficient_native', saved.record),
        needed: gas.needed,
        available: gas.available,
        resend: resendHandle(signed),
      };
    }
    return refusal(gas.reason, saved.record);
  }
  return await send(saved.record, signed, wallet, target, deps);
}

/** `value` raised by `EIP3009_GAS_MARGIN_BPS`, rounded up. */
function withGasMargin(value: bigint): bigint {
  return (value * EIP3009_GAS_MARGIN_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

async function nativeBalance(client: Eip1193Client, owner: string): Promise<bigint | null> {
  try {
    return readQuantity(
      await client.request({ method: 'eth_getBalance', params: [owner, 'latest'] }),
    );
  } catch {
    return null;
  }
}

type GasCheck =
  | { ok: true }
  | { ok: false; reason: 'rpc_error' | 'send_failed' | 'still_waiting' }
  | { ok: false; reason: 'insufficient_native'; needed: bigint; available: bigint };

/**
 * Step 5.1, a warning the buyer may override: `eth_estimateGas` of the signed
 * call with no fee fields, times the fee cap, times 1.5, plus the L1 fee x 1.5
 * on a chain with an `l1FeeOracle`, against the payer's native balance. An
 * execution error says nothing by its text: the nonce is read again - used
 * means watch, unused means nothing was sent (`send_failed`).
 */
async function checkGas(
  signed: SignedAttempt,
  target: Eip3009Target,
  deps: Pick<Eip3009PayDeps, 'client'>,
): Promise<GasCheck> {
  const { client } = deps;
  const estimate = await estimateTransferWithAuthorization(
    client,
    target.chain,
    signed.payer,
    signed.calldata,
  );
  if (estimate.kind === 'transport_error') {
    return { ok: false, reason: 'rpc_error' };
  }
  if (estimate.kind === 'execution_error') {
    const used = await readAuthorizationUsed(
      client,
      target.chain,
      target.asset,
      signed.payer,
      target.nonce,
      'latest',
    );
    if (used === 'used') {
      return { ok: false, reason: 'still_waiting' };
    }
    return { ok: false, reason: used === 'unused' ? 'send_failed' : 'rpc_error' };
  }
  let needed = withGasMargin(estimate.gas * estimate.feeCap);
  if (target.chain.l1FeeOracle !== undefined) {
    const l1Fee = await readL1Fee(client, target.chain, signed.calldata);
    if (l1Fee === null) {
      return { ok: false, reason: 'rpc_error' };
    }
    needed += withGasMargin(l1Fee);
  }
  const available = await nativeBalance(client, signed.payer);
  if (available === null) {
    return { ok: false, reason: 'rpc_error' };
  }
  if (available < needed) {
    return { ok: false, reason: 'insufficient_native', needed, available };
  }
  return { ok: true };
}

/** Store the hash of attempt `attemptId`, re-reading on a lost compare-and-swap. */
async function saveHash(
  record: OrderRecord,
  attemptId: string,
  hash: string,
  deps: Pick<Eip3009PayDeps, 'store'>,
): Promise<{ saved: boolean; record: OrderRecord }> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    const marker = current.marker;
    if (
      current.state !== 'paying' ||
      marker?.rail !== 'eip3009' ||
      marker.attemptId !== attemptId
    ) {
      return { saved: false, record: current };
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
    if (written.reason !== 'conflict') {
      return { saved: false, record: current };
    }
    current = await deps.store.get(record.orderId);
  }
  return { saved: false, record: current ?? record };
}

/**
 * The receipt (kind 17) for `hash`, and the marker's note of which transaction
 * the stored receipt names (`receiptTx`): a later `txHash` that differs sends
 * a new one. A lost note only sends the same receipt again.
 */
async function sendEip3009Receipt(
  record: OrderRecord,
  hash: string,
  deps: Eip3009WatchDeps,
): Promise<OrderRecord> {
  const receipt = await sendReceipt(record, hash, (deps.now ?? nowSecs)(), deps);
  if (!receipt.ok) {
    return record;
  }
  let current: OrderRecord | undefined = receipt.record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    const marker = current.marker;
    if (current.state !== 'paying' || marker?.rail !== 'eip3009' || marker.receiptTx === hash) {
      return current;
    }
    const written = await deps.store.updateMarker(
      current.orderId,
      current.version,
      marker.attemptId,
      { ...marker, receiptTx: hash },
    );
    if (written.ok) {
      return written.record;
    }
    if (written.reason !== 'conflict') {
      return current;
    }
    current = await deps.store.get(record.orderId);
  }
  return current ?? receipt.record;
}

/**
 * Step 6: only while the latest block time is at least `SEND_MARGIN_SECS`
 * below the signature's `validBefore` (closer: sign again), and only once the
 * wallet's own `eth_chainId` names the payout's chain - the one guard, since a
 * wallet may send to its current chain whatever `chainId` the call carries.
 * Then `eth_sendTransaction`, the hash stored, and the receipt.
 */
async function send(
  record: OrderRecord,
  signed: SignedAttempt,
  wallet: Eip3009Wallet,
  target: Eip3009Target,
  deps: Eip3009WatchDeps,
): Promise<Eip3009PayResult> {
  const { attemptId } = signed;
  const validBefore = BigInt(signed.typed.message.validBefore);
  const latest = await readBlockAtTag(deps.client, 'latest');
  if (latest === null) {
    return { ...refusal('rpc_error', record), resend: resendHandle(signed) };
  }
  if (BigInt(latest.timestamp + SEND_MARGIN_SECS) > validBefore) {
    return refusal('resign_needed', record);
  }
  const walletChain = await wallet.chainId().catch(() => undefined);
  if (walletChain !== target.chain.evmChainId) {
    return { ...refusal('wrong_chain_after_sign', record), resend: resendHandle(signed) };
  }
  let returned: string;
  try {
    returned = await wallet.sendTransaction({
      from: signed.payer,
      to: target.token,
      data: signed.calldata,
      chainId: chainIdHex(target.chain),
    });
  } catch (error) {
    if (errorCode(error) === USER_REJECTED) {
      return { ...refusal('send_declined', record), resend: resendHandle(signed) };
    }
    signed.sends.sent = true;
    return refusal('wallet_failed', record);
  }
  signed.sends.sent = true;
  const hash = readTxHash(returned);
  if (hash === null) {
    return refusal('wallet_failed', record);
  }
  const after = await readBlockAtTag(deps.client, 'latest');
  const nearExpiry =
    after !== null && BigInt(after.timestamp + SEND_MARGIN_SECS) > validBefore
      ? ({ nearExpiry: true } as const)
      : {};
  const saved = await saveHash(record, attemptId, hash, deps);
  if (!saved.saved) {
    return { ok: true, record: saved.record, hash, hashUnsaved: true, ...nearExpiry };
  }
  const receipted = await sendEip3009Receipt(saved.record, hash, deps);
  return { ok: true, record: receipted, hash, ...nearExpiry };
}

/**
 * Send again the signature an attempt holds in memory (`resend`, from
 * `insufficient_native`, `wrong_chain_after_sign` or `send_declined`): the
 * stored attempt must still be exactly that one, signed with that
 * `validBefore`. A wallet on another chain is asked to switch back and its
 * chain id read again; the margin and chain checks of step 6 still run.
 * Every handle of one attempt shares its sends: once the wallet was handed the
 * call (a hash came back, or it failed otherwise than by a decline), or while
 * another resend asks it, the answer is `not_payable` and nothing is sent.
 */
export async function resendWithEip3009(
  resend: Eip3009Resend,
  wallet: Eip3009Wallet,
  deps: Eip3009WatchDeps,
): Promise<Eip3009PayResult> {
  const signed = SIGNED_ATTEMPTS.get(resend);
  if (signed === undefined || signed.sends.sent || signed.sends.inFlight) {
    return refusal('not_payable');
  }
  signed.sends.inFlight = true;
  try {
    return await resendSigned(resend, signed, wallet, deps);
  } finally {
    signed.sends.inFlight = false;
  }
}

async function resendSigned(
  resend: Eip3009Resend,
  signed: SignedAttempt,
  wallet: Eip3009Wallet,
  deps: Eip3009WatchDeps,
): Promise<Eip3009PayResult> {
  const record = await deps.store.get(signed.orderId);
  if (record === undefined) {
    return refusal('not_payable');
  }
  const target = eip3009TargetOf(record);
  const marker = record.marker;
  if (
    target === undefined ||
    record.state !== 'paying' ||
    storeClosed(record) ||
    marker?.rail !== 'eip3009' ||
    !wellFormedMarker(marker) ||
    marker.attemptId !== signed.attemptId ||
    marker.signed !== true ||
    marker.signature !== signed.signature ||
    marker.authorizer !== signed.payer ||
    marker.validBefore !== signed.typed.message.validBefore
  ) {
    return refusal('not_payable', record);
  }
  const walletChain = await wallet.chainId().catch(() => undefined);
  if (walletChain !== target.chain.evmChainId) {
    try {
      await wallet.switchChain(target.chain);
    } catch {
      return { ...refusal('wrong_chain_after_sign', record), resend };
    }
  }
  return await send(record, signed, wallet, target, deps);
}

/** A retry or switch entry given a marker that never held a signature: clear it, then pay afresh. */
async function restartUnsigned(
  record: OrderRecord,
  marker: Eip3009Marker,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  let current: OrderRecord | undefined = record;
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS && current !== undefined; attempt += 1) {
    if (current.marker?.attemptId !== marker.attemptId || current.state !== 'paying') {
      break;
    }
    const cleared = await deps.store.clearMarker(
      current.orderId,
      current.version,
      marker.attemptId,
      'ordered',
    );
    if (cleared.ok) {
      return await payWithEip3009(cleared.record, wallet, fresh, deps);
    }
    if (cleared.reason !== 'conflict') {
      break;
    }
    current = await deps.store.get(record.orderId);
  }
  return refusal('conflict', current ?? record);
}

type RetryStart =
  | { ok: true; marker: Eip3009Marker; target: Eip3009Target }
  | { ok: false; result: Eip3009PayResult };

/** What a retry and a switch both require of the record before any wallet is asked. */
async function retryStart(
  record: OrderRecord,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<RetryStart> {
  const marker = record.marker;
  const target = eip3009TargetOf(record);
  if (
    target === undefined ||
    record.state !== 'paying' ||
    marker?.rail !== 'eip3009' ||
    !wellFormedMarker(marker)
  ) {
    return { ok: false, result: refusal('not_payable', record) };
  }
  if (marker.usedAtStart === true) {
    return { ok: false, result: refusal('nonce_used', record) };
  }
  if (storeClosed(record)) {
    return { ok: false, result: refusal('not_payable', record) };
  }
  if (marker.signed !== true) {
    return { ok: false, result: await restartUnsigned(record, marker, wallet, fresh, deps) };
  }
  if (storedEip3009Request(record) === undefined) {
    return { ok: false, result: refusal('not_payable', record) };
  }
  return { ok: true, marker, target };
}

/**
 * Pay again with the SAME wallet, in place (the order stays `paying`): only for
 * a signed marker (an unsigned one is cleared and paid afresh). Step 1 must
 * answer the marker's own account (another one is `other_payer`: the switch
 * path), step 2 runs in full, and a new `validBefore` =
 * `max(latest + 900, marker.validBefore)` is written BEFORE the prompt and
 * signed as is. No end proof is needed: one `(authorizer, nonce)` lands at most
 * once, so the old and the new signature exclude each other.
 */
export async function retryWithEip3009(
  record: OrderRecord,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  const start = await retryStart(record, wallet, fresh, deps);
  if (!start.ok) {
    return start.result;
  }
  const { marker, target } = start;
  const connected = await connect(wallet, target.chain);
  if (!connected.ok) {
    return connectRefusal(connected, record);
  }
  if (connected.payer !== marker.authorizer) {
    return refusal('other_payer', record);
  }
  return await againAttempt(
    record,
    marker,
    target,
    connected.payer,
    undefined,
    wallet,
    fresh,
    deps,
  );
}

/**
 * Pay with ANOTHER wallet (or account): only after the end proof of the
 * marker's authorizer - its authorization can never land - which the switch
 * write carries as `switchProof`. The same account is a plain retry.
 */
export async function switchWalletWithEip3009(
  record: OrderRecord,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  const start = await retryStart(record, wallet, fresh, deps);
  if (!start.ok) {
    return start.result;
  }
  const { marker, target } = start;
  const connected = await connect(wallet, target.chain);
  if (!connected.ok) {
    return connectRefusal(connected, record);
  }
  if (connected.payer === marker.authorizer) {
    return await againAttempt(
      record,
      marker,
      target,
      connected.payer,
      undefined,
      wallet,
      fresh,
      deps,
    );
  }
  const proof = await proveAuthorizationOver(marker, target, deps);
  if (proof.state === 'unreadable') {
    return refusal('rpc_error', record);
  }
  if (proof.state !== 'over') {
    return { ...refusal('still_waiting', record), proof: proof.state };
  }
  return await againAttempt(
    record,
    marker,
    target,
    connected.payer,
    proof.proof,
    wallet,
    fresh,
    deps,
  );
}

async function againAttempt(
  record: OrderRecord,
  marker: Eip3009Marker,
  target: Eip3009Target,
  payer: string,
  switchProof: Eip3009Proof | undefined,
  wallet: Eip3009Wallet,
  fresh: ReadyOffer,
  deps: Eip3009PayDeps,
): Promise<Eip3009PayResult> {
  const checked = await checkBeforeEip3009(record, target, payer, fresh, 'again', deps);
  if (!checked.ok) {
    return checked;
  }
  const fromLatest = BigInt(checked.latest.timestamp) + BigInt(EIP3009_VALID_SECS);
  const stored = BigInt(marker.validBefore);
  const validBefore = fromLatest > stored ? fromLatest : stored;
  const typed = typedDataFor(target, payer, validBefore);
  if (typed === undefined) {
    return refusal('unpayable', record);
  }
  const now = (deps.now ?? nowSecs)();
  const next: Eip3009Marker = {
    ...marker,
    attemptId: newAttemptId(deps),
    setAt: now,
    authorizer: payer,
    validBefore: validBefore.toString(),
    ...(switchProof === undefined ? {} : { switchProof }),
  };
  const replaced = await deps.store.updateMarker(
    record.orderId,
    record.version,
    marker.attemptId,
    next,
    now,
  );
  if (!replaced.ok) {
    return storeRefusal(replaced, record);
  }
  return await signAndSend(replaced.record, next, typed, payer, wallet, target, 'again', deps);
}

type ProofOutcome =
  | { state: 'over'; proof: Eip3009Proof }
  /** The finalized block is not past `validBefore` yet, or the authorization was used. */
  | { state: 'too_early' | 'used' }
  | { state: 'unreadable' };

/**
 * The end proof for the marker's authorizer: a block `F` at `finalized` whose
 * time is past `validBefore`, and `authorizationState` read PINNED to `F` by
 * hash, false (the chain re-bound first). True is used or canceled: canceled
 * (an `AuthorizationCanceled` in `[floorBlock, F]`, complete) counts as over,
 * used never does.
 */
async function proveAuthorizationOver(
  marker: Eip3009Marker,
  target: Eip3009Target,
  deps: Pick<Eip3009WatchDeps, 'client'>,
): Promise<ProofOutcome> {
  const finalized = await readFinalizedBlockWithHash(deps.client);
  if (finalized === null) {
    return { state: 'unreadable' };
  }
  if (BigInt(finalized.timestamp) <= BigInt(marker.validBefore)) {
    return { state: 'too_early' };
  }
  const proof = { blockHash: finalized.hash, timestamp: finalized.timestamp };
  const state = await readAuthorizationUsed(
    deps.client,
    target.chain,
    target.asset,
    marker.authorizer,
    target.nonce,
    { blockHash: finalized.hash },
  );
  if (state === 'unused') {
    return { state: 'over', proof };
  }
  if (state === 'unreadable') {
    return { state: 'unreadable' };
  }
  let canceled: Awaited<ReturnType<typeof readAuthorizationCanceled>>;
  try {
    canceled = await readAuthorizationCanceled(
      deps.client,
      target.asset,
      marker.authorizer,
      target.nonce,
      Number(marker.floorBlock),
      finalized.number,
    );
  } catch {
    return { state: 'unreadable' };
  }
  if (canceled.state === 'canceled') {
    return { state: 'over', proof };
  }
  return canceled.state === 'unreadable' ? { state: 'unreadable' } : { state: 'used' };
}

/**
 * What the end proof says of a record now, read-only (no wallet, no write):
 * what the checkout's "another wallet" and "end" act on. `over`: the signed
 * attempt can never land; `too_early`: no finalized block past `validBefore`
 * yet; `used`: it was used (paid, never ended); `unreadable`: ask again;
 * `not_needed`: no signed attempt, so nothing can land; `never`: a
 * `usedAtStart` marker, or no open `eip3009` order.
 */
export type Eip3009EndProofState =
  | 'over'
  | 'too_early'
  | 'used'
  | 'unreadable'
  | 'not_needed'
  | 'never';

type ProofSubject =
  | { kind: 'none'; state: 'not_needed' | 'never' }
  | { kind: 'signed'; marker: Eip3009Marker; target: Eip3009Target };

function proofSubjectOf(record: OrderRecord): ProofSubject {
  if (record.state === 'ordered' && record.marker === undefined) {
    return { kind: 'none', state: 'not_needed' };
  }
  const marker = record.marker;
  if (
    record.state !== 'paying' ||
    marker?.rail !== 'eip3009' ||
    marker.usedAtStart === true ||
    !wellFormedMarker(marker)
  ) {
    return { kind: 'none', state: 'never' };
  }
  if (marker.signed !== true) {
    return { kind: 'none', state: 'not_needed' };
  }
  const target = eip3009TargetOf(record);
  return target === undefined
    ? { kind: 'none', state: 'never' }
    : { kind: 'signed', marker, target };
}

export async function eip3009EndProof(
  record: OrderRecord,
  deps: Pick<Eip3009WatchDeps, 'client'>,
): Promise<Eip3009EndProofState> {
  const subject = proofSubjectOf(record);
  if (subject.kind === 'none') {
    return subject.state;
  }
  return (await proveAuthorizationOver(subject.marker, subject.target, deps)).state;
}

/**
 * End an `eip3009` order that will not be paid: at once when nothing was
 * requested; a marker that never held a signature ends without a proof; a
 * signed one only through the end proof, carried to the store (`endProof`);
 * a `usedAtStart` marker never, and with no read at all. `proof` says why.
 */
export async function endEip3009Order(
  record: OrderRecord,
  deps: Eip3009WatchDeps,
): Promise<{ ended: boolean; record: OrderRecord; proof: Eip3009EndProofState }> {
  const subject = proofSubjectOf(record);
  if (subject.kind === 'none') {
    if (subject.state === 'never') {
      return { ended: false, record, proof: 'never' };
    }
    const written =
      record.marker === undefined
        ? await deps.store.update(record.orderId, record.version, { state: 'ended-unpaid' })
        : await deps.store.clearMarker(
            record.orderId,
            record.version,
            record.marker.attemptId,
            'ended-unpaid',
          );
    return written.ok
      ? { ended: true, record: written.record, proof: 'not_needed' }
      : { ended: false, record, proof: 'not_needed' };
  }
  const proof = await proveAuthorizationOver(subject.marker, subject.target, deps);
  if (proof.state !== 'over') {
    return { ended: false, record, proof: proof.state };
  }
  const written = await deps.store.clearMarker(
    record.orderId,
    record.version,
    subject.marker.attemptId,
    'ended-unpaid',
    undefined,
    proof.proof,
  );
  return written.ok
    ? { ended: true, record: written.record, proof: 'over' }
    : { ended: false, record, proof: 'over' };
}

export type Eip3009Watch =
  /** The payment was found at the credit tag and recorded. */
  | { state: 'paid'; record: OrderRecord }
  /** A leg was found above the credit tag: confirming (`hash`). */
  | { state: 'confirming'; record: OrderRecord; hash: string }
  /** Nothing found yet: keep watching. */
  | { state: 'waiting'; record: OrderRecord }
  /** The chain answered something no verdict rests on: keep watching, say so after a while. */
  | { state: 'unsure'; record: OrderRecord }
  /** Delivered or refunded: nothing is left to watch. */
  | { state: 'closed'; record: OrderRecord };

export interface Eip3009WatchOptions {
  /** A hash returned in this session that is not stored yet. */
  pendingHash?: string;
}

/**
 * Record the payment found, with a receipt naming it unless the stored receipt
 * names it already: a retry's or another device's transaction needs its own.
 */
async function recordEip3009Paid(
  record: OrderRecord,
  hash: string,
  deps: Eip3009WatchDeps,
): Promise<OrderRecord> {
  let current: OrderRecord | undefined = record;
  const marker = record.marker?.rail === 'eip3009' ? record.marker : undefined;
  if (
    current.receiptWrap === undefined ||
    (current.state === 'paying' && marker?.receiptTx !== hash)
  ) {
    current = await sendEip3009Receipt(current, hash, deps);
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

/**
 * One look at an `eip3009` attempt (step 7): the attempt's own transactions by
 * hash (an unsaved `pendingHash` first, then the stored one), then every use of
 * the order's nonce from the marker's floor. A leg at
 * the credit tag is `paid`, above it `confirming`. While paying, a receipt is
 * sent for the attempt's hash when the stored one names another. No automatic
 * rebroadcast: the widget holds no raw transaction. A `usedAtStart` order is
 * not scanned: the store's status settles it.
 */
export async function watchEip3009Payment(
  record: OrderRecord,
  deps: Eip3009WatchDeps,
  options: Eip3009WatchOptions = {},
): Promise<Eip3009Watch> {
  if (isTerminal(record)) {
    return { state: 'closed', record };
  }
  if (record.paidTx !== undefined) {
    return { state: 'paid', record: await recordEip3009Paid(record, record.paidTx, deps) };
  }
  const target = eip3009TargetOf(record);
  if (
    record.marker?.rail !== 'eip3009' ||
    record.marker.usedAtStart === true ||
    !wellFormedMarker(record.marker) ||
    target === undefined ||
    storedEip3009Request(record) === undefined
  ) {
    return { state: 'waiting', record };
  }
  // A hash from the caller is read as one (lowercase) or not at all: a
  // malformed one is never stored, and a mixed-case one matches the stored one.
  const pendingHash =
    options.pendingHash === undefined ? undefined : (readTxHash(options.pendingHash) ?? undefined);
  let current = record;
  if (
    pendingHash !== undefined &&
    record.marker.txHash === undefined &&
    record.state === 'paying'
  ) {
    current = (await saveHash(record, record.marker.attemptId, pendingHash, deps)).record;
  }
  const marker: Eip3009Marker = current.marker?.rail === 'eip3009' ? current.marker : record.marker;
  // An unsaved hash (a retry whose write was refused) is followed in memory,
  // first, alongside the stored one: either may be the one that lands.
  const own = [
    ...new Set([pendingHash, marker.txHash].filter((hash): hash is string => hash !== undefined)),
  ];
  if (
    current.state === 'paying' &&
    marker.txHash !== undefined &&
    marker.receiptTx !== marker.txHash
  ) {
    current = await sendEip3009Receipt(current, marker.txHash, deps);
  }
  const legOptions = {
    chain: target.chain,
    asset: target.asset,
    nonce: target.nonce,
    to: target.payee,
    minValue: target.amount,
  };
  let unsure = false;
  let confirming: string | undefined;
  const judge = async (hash: string): Promise<Eip3009Watch | undefined> => {
    const legs = await readEip3009Legs(deps.client, hash, legOptions);
    if (legs.state === 'paid') {
      return { state: 'paid', record: await recordEip3009Paid(current, legs.leg.txHash, deps) };
    }
    if (legs.state === 'pending') {
      confirming = confirming ?? legs.leg.txHash;
    } else if (legs.state === 'unreadable') {
      unsure = true;
    }
    return undefined;
  };
  for (const hash of own) {
    const found = await judge(hash);
    if (found !== undefined) {
      return found;
    }
  }
  const latest = await readBlockAtTag(deps.client, 'latest');
  const floor = Number(marker.floorBlock);
  const walk =
    latest === null || !Number.isSafeInteger(floor)
      ? undefined
      : await listAuthorizationsByNonce(
          deps.client,
          target.asset,
          target.nonce,
          floor,
          latest.number,
        );
  if (walk === undefined || !walk.complete) {
    unsure = true;
  } else {
    const hashes = [...new Set(walk.logs.map((log) => log.txHash))].filter(
      (hash) => !own.includes(hash),
    );
    for (const hash of hashes) {
      const found = await judge(hash);
      if (found !== undefined) {
        return found;
      }
    }
  }
  if (confirming !== undefined) {
    return { state: 'confirming', record: current, hash: confirming };
  }
  return unsure ? { state: 'unsure', record: current } : { state: 'waiting', record: current };
}
