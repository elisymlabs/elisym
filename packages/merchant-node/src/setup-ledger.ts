import type { LedgerState } from './ledger';
import { type OfferTerms, publishTerms, retireTerms, standingTerms, visibleTerms } from './terms';

/**
 * The date to sign the payout list with: an unchanged list keeps the date it
 * was first signed (a new one would restart every buyer's "payout recently
 * changed" cool-down), but only while the relays' newest list is that very
 * one - otherwise re-signing an older date would never replace what buyers read.
 */
export function payoutListDate(
  state: LedgerState,
  payouts: string,
  newestOnRelays: number | undefined,
  now: number,
): number {
  const signed = state.payto;
  return signed !== undefined && signed.payouts === payouts && newestOnRelays === signed.createdAt
    ? signed.createdAt
    : now;
}

/** Why setup may not publish over what the ledger holds; `undefined` when it may. */
export function setupRefusal(state: LedgerState, productD: string): string | undefined {
  if (state.productD !== undefined && state.productD !== productD) {
    return `the product id changed from "${state.productD}" to "${productD}": the old listing would stay payable with no one taking its orders. Keep the id, or give a new product its own home.`;
  }
  return undefined;
}

export interface PublishOutcome {
  /** The listing (kind 30402) reached a relay. */
  listing: boolean;
  /** The owner's payout list (kind 10133) reached a relay. */
  payouts: boolean;
}

/**
 * Record in the ledger what buyers can read after a publish: the listing's
 * coins and price, paid to the payout list's addresses - each the new one only
 * if it reached a relay. `at` dates the change (a little before now).
 */
export function recordPublished(
  state: LedgerState,
  next: readonly OfferTerms[],
  outcome: PublishOutcome,
  at: number,
  payoutList: { createdAt: number; payouts: string },
  productD: string,
): void {
  const visible = visibleTerms(standingTerms(state.terms), next, outcome.listing, outcome.payouts);
  state.terms = retireTerms(
    state.terms,
    visible.map((terms) => terms.caip19),
    at,
  );
  for (const terms of visible) {
    state.terms = publishTerms(state.terms, terms, at);
  }
  if (outcome.payouts) {
    state.payto = payoutList;
  }
  if (outcome.listing) {
    state.productD = productD;
  }
}
