/**
 * The payer's half of a Tempo payment, for a wallet that signs it.
 *
 * Nothing here signs or reads a chain. A browser wallet signs over EIP-1193,
 * so what it sends is the request's calls: one
 * `transferWithMemo` per leg, every leg under the request's memo - the exact
 * shape the verifier looks for (`verifyTempoPayment`) and MetaMask's atomic
 * `wallet_sendCalls` produced on mainnet.
 *
 * Two entry points. `composeTempoPaymentRequest` builds the v2 request from the
 * parts a payer already holds - the payee, the price, the fee config it read -
 * so that a payer with no quote from a provider (the commerce checkout pays a
 * merchant's signed payout address directly) and the merchant that verifies it
 * later derive the SAME request with the same arithmetic. `buildTempoPaymentCalls`
 * turns a request, from either source, into the calls.
 */

import { PAYMENT_DEFAULTS } from '../constants';
import type { Asset } from '../payment/assets';
import { EVM_ASSETS } from '../payment/assets';
import type { ChainConfig } from '../payment/chains';
import {
  chainByCaip2,
  isEvmWireAddress,
  isVirtualEvmAddress,
  normalizeEvmAddress,
} from '../payment/chains';
import { calculateProtocolFeeSubunits } from '../payment/fee-subunits';
import { describeIssues } from '../payment/schema';
import type { ParsedPaymentRequestV2 } from '../payment/schema-v2';
import {
  caip19ForAsset,
  PaymentRequestV2Schema,
  resolveAssetFromPaymentRequestV2,
} from '../payment/schema-v2';
import { MAX_EVM_FEE_BPS } from './config';
import {
  EARLIEST_TEMPO_SECONDS,
  LATEST_TEMPO_SECONDS,
  TEMPO_UNPAYABLE_ADDRESSES,
  TRANSFER_WITH_MEMO_SELECTOR,
} from './constants';

const WORD_HEX_CHARS = 64;
const MAX_UINT256 = (1n << 256n) - 1n;
const MEMO_RE = /^0x[0-9a-f]{64}$/;

export interface ComposeTempoPaymentRequestOptions {
  /** A Tempo chain from the registry. */
  chain: ChainConfig;
  /** A coin of that chain, from the registry. */
  asset: Asset;
  /** The payee. Never a virtual address, never a protocol address. */
  recipient: string;
  /** The TOTAL the payer sends, in subunits. The fee comes out of it, as on every rail. */
  amount: bigint;
  /** The fee rate the payer read from the chain's config contract. */
  feeBps: number;
  /** The treasury the config names. Only read at a fee above zero. */
  treasury: string;
  /**
   * The memo that binds this payment to one order. A payer passes the one the
   * merchant issued or the one derived from the order - a memo the payer drew
   * itself is one a careful merchant never credits (see REPLAY below). Only a
   * caller that will verify the payment itself may draw a fresh one with
   * `randomTempoMemo()`.
   */
  memo: string;
  /**
   * Epoch seconds the request is dated, on the CHAIN's clock: the timestamp of
   * the finalized block read for `fromBlock`. Every deadline is judged on block
   * time, and a browser clock that runs behind would let a verifier conclude
   * "not paid" while the payment is still landing.
   */
  createdAt: number;
  expirySecs?: number;
}

/** The contracts of every registry coin: a token precompile holds no one's balance. */
const COIN_CONTRACTS: readonly string[] = EVM_ASSETS.flatMap((coin) =>
  coin.mint === undefined ? [] : [coin.mint.toLowerCase()],
);

/**
 * The v2 schema's verdict. A refusal names each field and a fixed reason, never
 * the value: a request can come from a remote provider, and the message can
 * reach a model (see `describeIssues`).
 */
function parseRequest(value: unknown): ParsedPaymentRequestV2 {
  const parsed = PaymentRequestV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(describeIssues(parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Whether money sent to `address` can reach someone: not a virtual address, not
 * one of the protocol's own system accounts, and not a coin's own contract.
 */
function isPayable(address: string): boolean {
  return (
    !isVirtualEvmAddress(address) &&
    !TEMPO_UNPAYABLE_ADDRESSES.includes(address) &&
    !COIN_CONTRACTS.includes(address)
  );
}

/**
 * The v2 request for paying `amount` of `asset` to `recipient`, with the fee
 * leg the config asks for. Throws on anything the payer must not send: the
 * v2 schema's own rules, a fee rate above the contract's ceiling, a protocol
 * address or the token itself as either destination, a date that is not
 * epoch seconds.
 *
 * A verifier that recomposes this request - the merchant, from an order and the
 * memo it was told - must pass the SAME `feeBps`, `treasury`, `createdAt` and
 * `expirySecs` the payer used, not the config or the default as they read
 * today: a fee switched on or a treasury rotated in between yields a different
 * request, and the payment no longer matches it; a different expiry moves the
 * verifier's deadline. Persist them with the order, and bound the fee the payer
 * claims against the chain's config independently. The verifier also needs the
 * block its scans start from (`fromBlock`), which no request carries: read the
 * finalized block BEFORE the payment is sent and persist it beside the rest, and
 * bound a payer-supplied `createdAt` against the verifier's own chain read.
 *
 * REPLAY. The memo is the only thing that binds a transfer to one request, and
 * a check by hash does not bound the payee leg by `fromBlock` or `created_at`.
 * So a verifier must
 * never accept a memo it cannot tie to the order by itself: a memo a payer
 * merely NAMES may be copied off the chain from any transfer the payout
 * address ever received - another shop, an MPP charge, an order dropped from
 * the store - and that transfer then verifies for the new order. Either the
 * verifier issues the memo, or it derives it from the order (a hash over the
 * store, the order id and the buyer, so no one can find an existing transfer
 * that carries it) and refuses any other. On top of that: claim
 * `tempoSettlementId(request, hash)` in a settlement store before crediting, so
 * one payment credits one order, and require every verified leg's
 * `blockNumber` to be at or above `fromBlock`.
 */
export function composeTempoPaymentRequest(
  options: ComposeTempoPaymentRequestOptions,
): ParsedPaymentRequestV2 {
  // Looked up by id, never compared by identity: each bundled entry point may
  // hold its own copy of the registry.
  const chain =
    typeof options.chain?.caip2 === 'string' ? chainByCaip2(options.chain.caip2) : undefined;
  if (chain?.family !== 'evm') {
    throw new Error('The chain is not an EVM chain from the registry.');
  }
  if (
    !Number.isInteger(options.createdAt) ||
    options.createdAt < EARLIEST_TEMPO_SECONDS ||
    options.createdAt > LATEST_TEMPO_SECONDS
  ) {
    // `Date.now()` where seconds were meant is the likeliest slip, and a
    // request dated in milliseconds never reaches its late deadline.
    throw new Error('createdAt must be a whole number of epoch SECONDS.');
  }
  if (typeof options.amount !== 'bigint' || options.amount <= 0n) {
    throw new Error('A payment needs a positive amount.');
  }
  // Through the registry, so a coin of another environment is refused here -
  // with a fixed message: `caip19ForAsset` quotes the caller's fields.
  let assetId: string;
  try {
    assetId = caip19ForAsset(chain.caip2, options.asset);
  } catch {
    throw new Error('The asset is not a coin of that chain.');
  }
  const recipient = normalizeEvmAddress(options.recipient);
  if (recipient === undefined || !isPayable(recipient)) {
    // The payee's address is not echoed: it comes from outside (a merchant's
    // signed payout event), and this message can reach a model.
    throw new Error('The payee is not an address a payment can go to.');
  }
  if (!Number.isInteger(options.feeBps) || options.feeBps < 0 || options.feeBps > MAX_EVM_FEE_BPS) {
    throw new Error(`The fee rate must be a whole number of bps from 0 to ${MAX_EVM_FEE_BPS}.`);
  }
  const feeAmount = calculateProtocolFeeSubunits(options.amount, options.feeBps);
  let feeLeg: { fee_address: string; fee_amount: string } | undefined;
  if (feeAmount > 0n) {
    const treasury = normalizeEvmAddress(options.treasury);
    if (treasury === undefined || !isPayable(treasury)) {
      throw new Error('The config names a treasury no payment can go to.');
    }
    if (treasury === recipient) {
      throw new Error('The treasury is the payee itself; the fee leg would be a self-transfer.');
    }
    if (feeAmount >= options.amount) {
      throw new Error('The amount is too small to carry the fee: the payee would receive nothing.');
    }
    feeLeg = { fee_address: treasury, fee_amount: feeAmount.toString() };
  }
  // Parsed by the schema every reader parses it with: a payer must never send
  // money under a request its own verifier refuses.
  return parseRequest({
    v: 2,
    chain: chain.caip2,
    asset: assetId,
    recipient,
    amount: options.amount.toString(),
    ...feeLeg,
    memo: options.memo,
    created_at: options.createdAt,
    expiry_secs: options.expirySecs ?? PAYMENT_DEFAULTS.PAYMENT_EXPIRY_SECS,
  });
}

/** One call for `wallet_sendCalls` (EIP-5792) or the `to` / `data` of a transaction. */
export interface TempoCall {
  /** The TIP-20 token. */
  to: string;
  data: string;
  /** Tempo has no native balance: a transfer never carries value. */
  value: '0x0';
}

export interface TempoPaymentLeg {
  to: string;
  amount: bigint;
  call: TempoCall;
}

export interface TempoPaymentCalls {
  /** The chain id as EIP-1193 wants it, e.g. `0x1079` on mainnet. */
  chainId: string;
  token: string;
  memo: string;
  /** `amount - fee_amount` to the payee. */
  provider: TempoPaymentLeg;
  /** `fee_amount` to the treasury, when the request carries a fee. */
  fee?: TempoPaymentLeg;
  /**
   * Every leg in order, payee first - the order MetaMask's atomic batch used on
   * mainnet. Send them atomically (`wallet_sendCalls` with `atomicRequired`);
   * a single call with no fee may go as a plain transaction. Never send two
   * legs one by one in this order: a wallet that cannot batch (Moderato has no
   * batching at all) needs the two-confirmation path, which pays the TREASURY
   * first and is not built here.
   */
  calls: TempoCall[];
}

function word(hexDigits: string): string {
  return hexDigits.padStart(WORD_HEX_CHARS, '0');
}

/** `transferWithMemo(address to, uint256 amount, bytes32 memo)` calldata. */
export function encodeTransferWithMemo(to: string, amount: bigint, memo: string): string {
  if (!isEvmWireAddress(to) || !isPayable(to)) {
    throw new Error('Not an address a payment can go to.');
  }
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new Error('The amount must be a positive uint256.');
  }
  if (!MEMO_RE.test(memo)) {
    throw new Error('A memo is 32 bytes of lowercase hex.');
  }
  return `${TRANSFER_WITH_MEMO_SELECTOR}${word(to.slice(2))}${word(amount.toString(16))}${memo.slice(2)}`;
}

/**
 * The calls that `payer` sends to pay `request`. The request is parsed again
 * and its coin, chain and destinations checked: a MALFORMED or unpayable
 * request is refused here, not encoded. The payer can be neither destination -
 * the verifier never counts a transfer to oneself, so such a leg is lost or
 * proves nothing.
 *
 * What it does NOT judge is whether the request is fair: the payee, the price,
 * the fee rate and who the fee goes to are taken as given. A request that came
 * from someone else - a provider's quote, anything off the wire - must pass
 * `validateTempoPaymentRequest` against the chain's config and the agreed price
 * first; only a request the payer composed itself from values it read may skip
 * that.
 *
 * Every payer, whoever composed the request, runs `checkTempoReceivePolicies`
 * before sending: a TIP-403 policy can refuse a transfer that still succeeds,
 * parking the money with the guard, where no verifier counts it as paid.
 */
export function buildTempoPaymentCalls(
  request: ParsedPaymentRequestV2,
  payer: string,
): TempoPaymentCalls {
  const parsed = parseRequest(request);
  const from = normalizeEvmAddress(payer);
  if (from === undefined || isVirtualEvmAddress(from)) {
    throw new Error('The payer is not an address.');
  }
  const chain = chainByCaip2(parsed.chain);
  if (chain?.evmChainId === undefined) {
    throw new Error(`${parsed.chain} is not a chain this SDK can pay on.`);
  }
  const asset = resolveAssetFromPaymentRequestV2(parsed);
  if (asset?.mint === undefined) {
    throw new Error(`${parsed.asset} is not a coin of ${parsed.chain}.`);
  }
  const destinations =
    parsed.fee_address === undefined ? [parsed.recipient] : [parsed.recipient, parsed.fee_address];
  const token = asset.mint;
  for (const destination of destinations) {
    if (!isPayable(destination)) {
      throw new Error(`Not an address a payment can go to: ${destination}`);
    }
    if (destination === from) {
      throw new Error(`The payer ${from} cannot pay itself.`);
    }
  }
  const feeAmount = parsed.fee_amount === undefined ? 0n : BigInt(parsed.fee_amount);
  const leg = (to: string, amount: bigint): TempoPaymentLeg => ({
    to,
    amount,
    call: { to: token, data: encodeTransferWithMemo(to, amount, parsed.memo), value: '0x0' },
  });
  const provider = leg(parsed.recipient, BigInt(parsed.amount) - feeAmount);
  const fee = parsed.fee_address === undefined ? undefined : leg(parsed.fee_address, feeAmount);
  const result: TempoPaymentCalls = {
    chainId: `0x${chain.evmChainId.toString(16)}`,
    token,
    memo: parsed.memo,
    provider,
    calls: fee === undefined ? [provider.call] : [provider.call, fee.call],
  };
  if (fee !== undefined) {
    result.fee = fee;
  }
  return result;
}
