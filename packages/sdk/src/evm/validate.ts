/**
 * The customer's side of a Tempo payment request: everything that must be true
 * BEFORE any money moves.
 *
 * Two halves, because they have different shapes. `validateTempoPaymentRequest`
 * is synchronous and reads nothing: it compares the request against the card
 * the price came from, the fee the chain says is due, and the caller's own
 * bounds. `checkTempoReceivePolicies` is the half that needs the chain - a
 * TIP-403 policy can refuse a transfer that otherwise succeeds, parking the
 * money with the guard and leaving the job unpaid, so both destinations are
 * asked before the customer signs anything.
 *
 * Order matters and is fixed: the chain gate comes before any money check that
 * is about THIS request - the fee arithmetic, the card's price, the clock - the
 * way the Solana validator puts the network gate first. A request settling
 * somewhere else must never reach the fee arithmetic. The session cap is the
 * one exception, and it is not one in substance: the parser enforces it while
 * reading the amount, before anything at all has been decided, and the code
 * that enforced it a second time down here was removed as unreachable.
 */

import type { Asset } from '../payment/assets';
import { assetKey } from '../payment/assets';
import type { ChainConfig } from '../payment/chains';
import { isEvmWireAddress, isVirtualEvmAddress } from '../payment/chains';
import { calculateProtocolFeeSubunits } from '../payment/fee-subunits';
import type { ParsedPaymentRequestV2 } from '../payment/schema-v2';
import { parseAnyPaymentRequest, resolveAssetFromPaymentRequestV2 } from '../payment/schema-v2';
import type { PaymentValidationError } from '../types';
import type { Eip1193Client } from './client';
import { checkEvmChain, MAX_EVM_FEE_BPS } from './config';
import {
  TEMPO_POLICY_REGISTRY,
  TEMPO_UNPAYABLE_ADDRESSES,
  VALIDATE_RECEIVE_POLICY_SELECTOR,
} from './constants';
import { readUint256, readWords } from './rpc-read';

/** How long a request may sit unpaid before its window is too short to be worth starting. */
export const MIN_PAY_WINDOW_SECS = 120;

export interface TempoPaymentCard {
  recipient: string;
  asset: Asset;
  /** The card's own price. ABSENT means a bound of zero, never "no bound". */
  jobPriceSubunits?: bigint;
}

interface TempoPaymentLimits {
  /**
   * The chain this customer is willing to pay on - its own environment's. It
   * must be a REGISTRY entry: the asset check below rests on the registry
   * holding the request's coin for this chain and network.
   */
  chain: ChainConfig;
  /** The payer's own address. It can be neither destination: such a leg proves nothing. */
  payer: string;
  /** The session cap, in the asset's subunits. */
  maxAmountSubunits?: bigint;
  /** The fee the chain says is due, read from the config contract. */
  protocolFeeBps: number;
  /** The treasury the chain names. Only meaningful at a fee above zero. */
  treasury: string;
  nowSecs?: number;
}

/**
 * What the request is checked AGAINST - and it is a union on purpose. A bounds
 * value with neither a card nor an agreed asset and cap binds nothing at all:
 * every recipient and every amount would be acceptable, which is the one shape
 * this function must never be handed. It does not typecheck.
 */
export type TempoPaymentBounds = TempoPaymentLimits &
  (
    | { card: TempoPaymentCard; expectedAsset?: Asset }
    | {
        card?: undefined;
        /** Without a card, the asset and the cap ARE the binding, so both are required. */
        expectedAsset: Asset;
        maxAmountSubunits: bigint;
      }
  );

function refuse(code: PaymentValidationError['code'], message: string): PaymentValidationError {
  return { code, message };
}

/**
 * The schema is the first gate, and most of what it refuses has a better name
 * than "invalid json": a chain this SDK does not know, an asset that is not a
 * CAIP-19 id of it, an amount over the session cap. The message already names
 * the field; this puts the right CODE on it, so a caller switching on the code
 * does not have to read English.
 */
function parseFailureCode(error: {
  code: string;
  message: string;
}): PaymentValidationError['code'] {
  if (error.code === 'unsupported_version') {
    return 'unsupported_version';
  }
  if (error.code === 'amount_exceeds_max') {
    return 'invalid_amount';
  }
  if (error.code === 'schema') {
    if (/\bchain\b/.test(error.message)) {
      return 'unsupported_chain';
    }
    if (/\basset\b/.test(error.message)) {
      return 'invalid_asset';
    }
    if (/\brecipient\b/.test(error.message)) {
      return 'invalid_recipient_address';
    }
    if (/\bfee_address\b/.test(error.message)) {
      return 'fee_address_mismatch';
    }
    if (/\bfee_amount\b/.test(error.message)) {
      return 'fee_amount_mismatch';
    }
    return 'invalid_amount';
  }
  return 'invalid_json';
}

/**
 * Validate a payment request a provider sent, against the card it was quoted
 * from and the fee the chain says is due. `null` means it may be paid.
 *
 * Every branch refuses. There is no path where an unreadable field, an unknown
 * asset or an absent price is treated as permission - the money is the
 * customer's, and the only safe default is not to spend it.
 */
export function validateTempoPaymentRequest(
  requestJson: string,
  bounds: TempoPaymentBounds,
): PaymentValidationError | null {
  // The session cap is enforced HERE, by the parse gate, for both versions -
  // there is no second check below, and adding one would be unreachable.
  const parsed = parseAnyPaymentRequest(requestJson, {
    ...(bounds.maxAmountSubunits === undefined
      ? {}
      : { maxAmountSubunits: bounds.maxAmountSubunits }),
  });
  if (!parsed.ok) {
    return refuse(parseFailureCode(parsed.error), parsed.error.message);
  }
  if (parsed.version !== 2) {
    return refuse(
      'unsupported_version',
      `This is a version ${parsed.version} payment request; a Tempo payment is version 2.`,
    );
  }
  const request = parsed.data;

  // Every one of these is lowercased below, which THROWS on anything that is
  // not a string - and this function's contract is to refuse, never to throw.
  const addresses = [
    bounds.payer,
    bounds.treasury,
    ...(bounds.card === undefined ? [] : [bounds.card.recipient]),
  ];
  if (addresses.some((address) => typeof address !== 'string')) {
    return refuse('invalid_bounds', 'These bounds carry an address that is not a string.');
  }

  // The chain gate FIRST, before any money check. A chain the registry does
  // not carry never reaches here - the v2 schema refuses it, and
  // `parseFailureCode` gives that refusal its `unsupported_chain` code.
  if (request.chain !== bounds.chain.caip2) {
    return refuse(
      'chain_mismatch',
      `Chain mismatch: this customer pays on ${bounds.chain.caip2}, and the request settles ` +
        `on ${request.chain}. Cross-chain payments are not possible.`,
    );
  }

  const asset = resolveAssetFromPaymentRequestV2(request);
  if (asset === undefined) {
    return refuse(
      'invalid_asset',
      `The request names ${request.asset}, which is not a coin this SDK knows on that chain.`,
    );
  }
  // A resolved asset is a coin of THIS environment by construction: the
  // resolver looks it up through the request chain's own environment, and the
  // gate above has already settled that the request chain is this one.
  if (
    bounds.card !== undefined &&
    bounds.expectedAsset !== undefined &&
    assetKey(bounds.card.asset) !== assetKey(bounds.expectedAsset)
  ) {
    // The union allows both, and `??` takes the card's - silently dropping the
    // asset the session agreed to. Two bounds that name different coins are
    // not a bound at all; which one wins should not be decided here.
    return refuse(
      'invalid_bounds',
      `These bounds disagree about the coin: the card pays ${bounds.card.asset.token} and ` +
        `the session agreed ${bounds.expectedAsset.token}.`,
    );
  }
  const agreed = bounds.card?.asset ?? bounds.expectedAsset;
  if (agreed === undefined) {
    // Unreachable for a caller that typechecks - the bounds union requires one
    // of the two - and a refusal rather than a silent pass for one that casts.
    return refuse('invalid_asset', 'These bounds name no asset to pay, so nothing may be paid.');
  }
  if (assetKey(agreed) !== assetKey(asset)) {
    return refuse(
      'asset_mismatch',
      `Asset mismatch: agreed to pay ${agreed.token}, but the request debits ${asset.token}.`,
    );
  }

  if (bounds.card !== undefined && request.recipient !== bounds.card.recipient.toLowerCase()) {
    return refuse(
      'recipient_mismatch',
      `Recipient mismatch: the card names ${bounds.card.recipient}, the request pays ` +
        `${request.recipient}.`,
    );
  }
  // Three protocol system accounts and the burn address. Money sent to any of
  // them is gone, and the fee sink is excluded from every leg match by name -
  // a payment there could never be read back as delivered.
  const destinations = [request.recipient, request.fee_address];
  const unpayable = destinations.find(
    (destination) => destination !== undefined && TEMPO_UNPAYABLE_ADDRESSES.includes(destination),
  );
  if (unpayable !== undefined) {
    return refuse(
      'invalid_recipient_address',
      `${unpayable} is a protocol address; a payment to it is not a payment.`,
    );
  }
  const payer = bounds.payer.toLowerCase();
  if (!isEvmWireAddress(payer) || isVirtualEvmAddress(payer)) {
    return refuse(
      'invalid_recipient_address',
      `Not an address this rail can pay from: ${bounds.payer}.`,
    );
  }
  // A leg whose sides are equal moves nothing and counts for nothing, so a
  // request pointed back at the payer can only ever waste the gas.
  if (payer === request.recipient || payer === request.fee_address) {
    return refuse(
      'self_payment',
      "This request pays the customer's own address, which settles nothing.",
    );
  }

  // `NaN` compares FALSE against every one of the three time gates below, so
  // an unusable clock would open all of them at once - a request that expired
  // a day ago and one dated a year ahead both become payable. `Number.isFinite`
  // does not coerce, so it also catches a string of seconds, which would turn
  // `now + MIN_PAY_WINDOW_SECS` into string concatenation.
  const now = bounds.nowSecs ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) {
    return refuse('invalid_bounds', `These bounds carry no usable clock: ${bounds.nowSecs}.`);
  }
  if (request.created_at > now + MIN_PAY_WINDOW_SECS) {
    return refuse(
      'future_timestamp',
      `The request is dated ${request.created_at - now} seconds in the future.`,
    );
  }
  const expiresAt = request.created_at + request.expiry_secs;
  if (expiresAt <= now) {
    return refuse('expired', `The request expired ${now - expiresAt} seconds ago.`);
  }
  if (expiresAt - now < MIN_PAY_WINDOW_SECS) {
    return refuse(
      'expired',
      `Only ${expiresAt - now} seconds are left on this request; a payment needs at least ` +
        `${MIN_PAY_WINDOW_SECS}.`,
    );
  }

  const feeProblem = checkFee(request, bounds);
  if (feeProblem !== null) {
    return feeProblem;
  }

  const amount = BigInt(request.amount);
  const cap = bounds.maxAmountSubunits;
  const price = bounds.card?.jobPriceSubunits;
  if (
    (cap !== undefined && typeof cap !== 'bigint') ||
    (price !== undefined && typeof price !== 'bigint')
  ) {
    // Cast past the type and `amount > priceBound` compares a bigint against a
    // string, which is a relational comparison and false for every large
    // amount - so the card's price would bound nothing at all.
    return refuse('invalid_bounds', 'These bounds carry a price that is not a number of subunits.');
  }
  if (bounds.card === undefined && cap === undefined) {
    // Unreachable for a caller that typechecks - without a card the union
    // requires the cap - and the same refusal the asset half already makes for
    // one that casts. Neither half of the binding is present here: no card to
    // fix the recipient, no cap to fix the amount, so every address and every
    // amount would be acceptable.
    return refuse('invalid_bounds', 'These bounds bound no amount, so nothing may be paid.');
  }
  if (bounds.card !== undefined) {
    // An absent price is a bound of ZERO, not the absence of a bound: a card
    // that never published a price cannot charge for anything.
    const priceBound = bounds.card.jobPriceSubunits ?? 0n;
    if (amount > priceBound) {
      return refuse(
        'invalid_amount',
        `The request asks for ${request.amount}, above the ${priceBound} this card published.`,
      );
    }
  }
  return null;
}

/**
 * The fee leg must be EXACTLY what the chain says, or absent exactly when the
 * chain says there is no fee. A provider that names its own address as the
 * treasury, or rounds the fee down, is taking elisym's cut.
 */
function checkFee(
  request: ParsedPaymentRequestV2,
  bounds: TempoPaymentBounds,
): PaymentValidationError | null {
  // Read before it is used: the fee arithmetic THROWS on a rate that is not a
  // whole number of basis points, and this function's whole contract is that
  // it returns a refusal instead of throwing.
  if (
    !Number.isInteger(bounds.protocolFeeBps) ||
    bounds.protocolFeeBps < 0 ||
    bounds.protocolFeeBps > MAX_EVM_FEE_BPS
  ) {
    return refuse(
      'invalid_bounds',
      `The chain answered a protocol fee of ${bounds.protocolFeeBps} bps, which is not a fee.`,
    );
  }
  if (bounds.protocolFeeBps === 0) {
    if (request.fee_address !== undefined || request.fee_amount !== undefined) {
      return refuse(
        'invalid_fee_params',
        'The request carries a fee leg, and the chain says the protocol fee is zero.',
      );
    }
    return null;
  }
  if (request.fee_address === undefined || request.fee_amount === undefined) {
    return refuse(
      'missing_fee',
      `The chain charges ${bounds.protocolFeeBps} bps and the request carries no fee leg.`,
    );
  }
  const expected = calculateProtocolFeeSubunits(BigInt(request.amount), bounds.protocolFeeBps);
  if (request.fee_address !== bounds.treasury.toLowerCase()) {
    return refuse(
      'fee_address_mismatch',
      `The fee leg pays ${request.fee_address}; the chain names ${bounds.treasury}.`,
    );
  }
  if (BigInt(request.fee_amount) !== expected) {
    return refuse(
      'fee_amount_mismatch',
      `The fee leg is ${request.fee_amount}; ${bounds.protocolFeeBps} bps of ${request.amount} ` +
        `is ${expected}.`,
    );
  }
  return null;
}

export interface ReceivePolicyCheck {
  /** The chain the policies live on. Read before anything is asked of it. */
  chain: ChainConfig;
  token: string;
  payer: string;
  recipient: string;
  /** The treasury, when a fee leg is due. */
  feeAddress?: string;
}

export type ReceivePolicyVerdict =
  | { ok: true }
  | { ok: false; leg: 'provider' | 'fee'; reason: 'blocked' | 'unreadable'; message: string };

/**
 * Ask the chain whether each destination will actually accept this token from
 * this payer, before anything is signed.
 *
 * A blocked transfer SUCCEEDS: the funds sit with the guard, the memo log is
 * never emitted, and the provider reads the payment as never sent. The customer
 * has paid and has nothing. So an UNREADABLE answer refuses too - zero is the
 * accepting value of the second word, and a short answer must never decode as
 * permission.
 */
export async function checkTempoReceivePolicies(
  client: Eip1193Client,
  check: ReceivePolicyCheck,
): Promise<ReceivePolicyVerdict> {
  // The registry lives at the same system address on both Tempo networks and
  // answers plausibly on either, so asking the wrong one is not an error the
  // read itself can report: measured, a receiver that refuses on its own chain
  // answers `(1, 0)` - open - on the other.
  const onThisChain = await checkEvmChain(client, check.chain).catch(() => null);
  if (onThisChain === null) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: `Could not confirm the endpoint is ${check.chain.caip2}; refusing to read a policy blind.`,
    };
  }
  if (isVirtualEvmAddress(check.payer)) {
    // The same TIP-1022 split as a virtual destination, on the sending side:
    // the registry would answer about the alias while the transfer is
    // evaluated against its master.
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: `${check.payer} is a virtual address; the policy that applies is its master's.`,
    };
  }
  const legs: { leg: 'provider' | 'fee'; to: string }[] = [
    { leg: 'provider', to: check.recipient },
    ...(check.feeAddress === undefined ? [] : [{ leg: 'fee' as const, to: check.feeAddress }]),
  ];
  for (const { leg, to } of legs) {
    if (isVirtualEvmAddress(to)) {
      // TIP-1022: the registry answers for the ALIAS, which can never carry a
      // policy, while the transfer is resolved to its master and the master's
      // policy is what blocks it. The one read this function exists to make is
      // meaningless here, so it is not made.
      return {
        ok: false,
        leg,
        reason: 'unreadable',
        message: `${to} is a virtual address; its receive policy is its master's, which cannot be read.`,
      };
    }
    const allowed = await readValidateReceivePolicy(client, check.token, check.payer, to);
    if (allowed === null) {
      return {
        ok: false,
        leg,
        reason: 'unreadable',
        message: `Could not read whether ${to} accepts ${check.token}; refusing to pay blind.`,
      };
    }
    if (!allowed) {
      return {
        ok: false,
        leg,
        reason: 'blocked',
        message:
          `${to} does not accept this token from this address: the transfer would succeed on ` +
          `chain and the money would sit with the guard, out of reach of both of you.`,
      };
    }
  }
  // Every answer above came from an endpoint that named this chain before the
  // first read. `ok` is permission to move money, so it is asked once more -
  // the registry lives at the same address on both networks and answers
  // plausibly on either, which is exactly how a mid-call network switch would
  // turn a refusal into a yes.
  if ((await checkEvmChain(client, check.chain).catch(() => null)) === null) {
    return {
      ok: false,
      leg: 'provider',
      reason: 'unreadable',
      message: `${check.chain.caip2} could not be confirmed after the reads; refusing to pay blind.`,
    };
  }
  return { ok: true };
}

/** Exactly 64 bytes, and only `(1, 0)` is a yes. `null` means unreadable. */
async function readValidateReceivePolicy(
  client: Eip1193Client,
  token: string,
  payer: string,
  recipient: string,
): Promise<boolean | null> {
  const argument = (address: string): string =>
    `${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  const raw = await client
    .request({
      method: 'eth_call',
      params: [
        {
          to: TEMPO_POLICY_REGISTRY,
          data: `${VALIDATE_RECEIVE_POLICY_SELECTOR}${argument(token)}${argument(payer)}${argument(recipient)}`,
        },
        'finalized',
      ],
    })
    .catch(() => null);
  const words = readWords(raw, 2);
  const authorized = readUint256(words?.[0]);
  const reason = readUint256(words?.[1]);
  if (authorized === null || reason === null) {
    return null;
  }
  return authorized === 1n && reason === 0n;
}
