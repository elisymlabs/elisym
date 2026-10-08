/**
 * The protocol fee of a commerce payment, as the buyer decides it: one policy
 * (`feePlanFor`) run at every decision point - before ordering, when the
 * payment request is composed, and right before anything is signed - against
 * fee terms read fresh each time.
 *
 * The stored payment request IS the fee snapshot: its `fee_address` /
 * `fee_amount` are written once with it. A pre-sign check plans again and
 * compares AMOUNTS with what is stored (`sameFeePlan`); any difference is
 * `offer_changed` - the order ends and a new quote starts.
 */
import { type FeeTerms, FeeConfigError, feeAmountFor } from '@elisym/pay-core';
import type { VerifiedOffer } from '../verify-offer';

/**
 * The fee terms for a chain (CAIP-2), read fresh: the checkout and the MCP wire
 * `readFeeTerms` over a Solana RPC of the paired config network. Throws
 * `FeeConfigError`; anything else it throws counts as `unavailable`.
 */
export type FeeTermsSource = (chain: string) => Promise<FeeTerms>;

/** A fee leg of `amount` subunits to `treasury`; `{ amount: 0n, treasury: '' }` is none. */
export interface FeePlan {
  amount: bigint;
  treasury: string;
}

/** No fee leg: what a request without fee fields carries. */
export const NO_FEE: FeePlan = { amount: 0n, treasury: '' };

export type FeeRefusal =
  /** The fee is above 0 and the store's node does not declare split support: it would refuse the payment. */
  | 'store_outdated'
  /** The fee terms could not be read now. Nothing was requested; ask again. */
  | 'fee_config_unavailable'
  /** elisym's fee configuration cannot be used right now (asking again will not help). */
  | 'fee_config_invalid';

export type FeePlanResult = { ok: true; plan: FeePlan } | { ok: false; reason: FeeRefusal };

/**
 * THE buyer policy: the fee leg a payment of `price` on these terms carries.
 * A zero fee amount (`feeAmountFor`: rate 0, the treasury is the payout or the
 * payer, a 1-subunit price) is no leg, for any store. Above zero, only a store
 * that declares fee support gets a leg; any other is refused `store_outdated`.
 */
export function feePlanFor(
  offer: Pick<VerifiedOffer, 'feeSupport'>,
  terms: FeeTerms,
  parties: { payout: string; payer?: string },
  price: bigint,
): FeePlanResult {
  const amount = feeAmountFor(price, terms, parties);
  if (amount === 0n) {
    return { ok: true, plan: NO_FEE };
  }
  if (offer.feeSupport !== true) {
    return { ok: false, reason: 'store_outdated' };
  }
  return { ok: true, plan: { amount, treasury: terms.treasury } };
}

/**
 * The buyer reason for a failed fee-terms read: `unavailable` (and anything
 * that is not a `FeeConfigError`) is retryable; a wrong cluster, a missing EVM
 * treasury or a bad config is not.
 */
export function feeRefusalOf(error: unknown): 'fee_config_unavailable' | 'fee_config_invalid' {
  if (error instanceof FeeConfigError && error.code !== 'unavailable') {
    return 'fee_config_invalid';
  }
  return 'fee_config_unavailable';
}

/** Read the terms for `chain` and plan the fee: every refusal is a reason, nothing throws. */
export async function planFee(
  feeTerms: FeeTermsSource,
  chain: string,
  offer: Pick<VerifiedOffer, 'feeSupport'>,
  parties: { payout: string; payer?: string },
  price: bigint,
): Promise<FeePlanResult> {
  let terms: FeeTerms;
  try {
    terms = await feeTerms(chain);
  } catch (error) {
    return { ok: false, reason: feeRefusalOf(error) };
  }
  return feePlanFor(offer, terms, parties, price);
}

/** The fee leg a stored request carries (absent fields are no leg). */
export function storedFeePlan(request: {
  fee_address?: string | undefined;
  fee_amount?: number | string | undefined;
}): FeePlan {
  const amount = request.fee_amount === undefined ? 0n : BigInt(request.fee_amount);
  if (amount === 0n) {
    return NO_FEE;
  }
  return { amount, treasury: request.fee_address ?? '' };
}

/** Whether two plans are the same leg: amounts exactly, treasuries EVM case-insensitively. */
export function sameFeePlan(stored: FeePlan, fresh: FeePlan): boolean {
  if (stored.amount !== fresh.amount) {
    return false;
  }
  if (stored.amount === 0n) {
    return true;
  }
  return stored.treasury.startsWith('0x')
    ? stored.treasury.toLowerCase() === fresh.treasury.toLowerCase()
    : stored.treasury === fresh.treasury;
}
