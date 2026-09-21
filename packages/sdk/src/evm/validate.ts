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
 * Order matters and is fixed: the chain gate comes before any money check, the
 * way the Solana validator puts the network gate first. A request settling
 * somewhere else must never reach the fee arithmetic.
 */

import type { Asset } from '../payment/assets';
import { assetKey, assetsFor } from '../payment/assets';
import type { ChainConfig } from '../payment/chains';
import { chainByCaip2, isEvmWireAddress, isVirtualEvmAddress } from '../payment/chains';
import { calculateProtocolFeeSubunits } from '../payment/fee-subunits';
import type { ParsedPaymentRequestV2 } from '../payment/schema-v2';
import { parseAnyPaymentRequest, resolveAssetFromPaymentRequestV2 } from '../payment/schema-v2';
import type { PaymentValidationError } from '../types';
import type { Eip1193Client } from './client';
import { TEMPO_POLICY_REGISTRY, VALIDATE_RECEIVE_POLICY_SELECTOR } from './constants';
import { readUint256, readWords } from './rpc-read';

/** How long a request may sit unpaid before its window is too short to be worth starting. */
export const MIN_PAY_WINDOW_SECS = 120;

export interface TempoPaymentBounds {
  /** The chain this customer is willing to pay on - its own environment's. */
  chain: ChainConfig;
  /** The payer's own address. It can be neither destination: such a leg proves nothing. */
  payer: string;
  /**
   * The card the price came from. Absent for a bare `send_payment`, where the
   * asset the caller agreed to is the whole binding and the session cap is the
   * only price bound.
   */
  card?: {
    recipient: string;
    asset: Asset;
    /** The card's own price. ABSENT means a bound of zero, never "no bound". */
    jobPriceSubunits?: bigint;
  };
  /** Without a card: the asset the caller agreed to pay. */
  expectedAsset?: Asset;
  /** The session cap, in the asset's subunits. */
  maxAmountSubunits?: bigint;
  /** The fee the chain says is due, read from the config contract. */
  protocolFeeBps: number;
  /** The treasury the chain names. Only meaningful at a fee above zero. */
  treasury: string;
  nowSecs?: number;
}

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

  // The chain gate FIRST, before any money check.
  const requestChain = chainByCaip2(request.chain);
  if (requestChain === undefined) {
    return refuse('unsupported_chain', `This SDK does not know the chain ${request.chain}.`);
  }
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
  const agreed = bounds.card?.asset ?? bounds.expectedAsset;
  if (agreed !== undefined && assetKey(agreed) !== assetKey(asset)) {
    return refuse(
      'asset_mismatch',
      `Asset mismatch: agreed to pay ${agreed.token}, but the request debits ${asset.token}.`,
    );
  }
  // An asset that does not exist on this environment resolves fine above and
  // would fail only after the customer signed.
  if (
    !assetsFor(bounds.chain.slug, bounds.chain.network).some((known) => known.mint === asset.mint)
  ) {
    return refuse(
      'invalid_asset',
      `${asset.token} is not a coin of ${bounds.chain.caip2} on ${bounds.chain.network}.`,
    );
  }

  if (bounds.card !== undefined && request.recipient !== bounds.card.recipient.toLowerCase()) {
    return refuse(
      'recipient_mismatch',
      `Recipient mismatch: the card names ${bounds.card.recipient}, the request pays ` +
        `${request.recipient}.`,
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

  const now = bounds.nowSecs ?? Math.floor(Date.now() / 1000);
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
  if (bounds.maxAmountSubunits !== undefined && amount > bounds.maxAmountSubunits) {
    return refuse(
      'invalid_amount',
      `The request asks for ${request.amount}, above this session's cap of ` +
        `${bounds.maxAmountSubunits}.`,
    );
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
  const expected = calculateProtocolFeeSubunits(BigInt(request.amount), bounds.protocolFeeBps);
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
  const legs: { leg: 'provider' | 'fee'; to: string }[] = [
    { leg: 'provider', to: check.recipient },
    ...(check.feeAddress === undefined ? [] : [{ leg: 'fee' as const, to: check.feeAddress }]),
  ];
  for (const { leg, to } of legs) {
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
