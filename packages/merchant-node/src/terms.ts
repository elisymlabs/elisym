import { TERMS_WINDOW_SECS } from './constants';

/** What the store asked for one product in one coin: pay `amount` to `payout`. */
export interface OfferTerms {
  /** The product (`d`) these terms sell: a price is one product's, never the store's. */
  d: string;
  /** CAIP-19 id of the coin. */
  caip19: string;
  /** The owner's payout address for it (the wallet, not a token account). */
  payout: string;
  /** Decimal string of the coin's subunits (quantity 1). */
  amount: string;
}

/** Terms as published, and when they were replaced (absent while they stand). */
export interface TermsPeriod {
  terms: OfferTerms;
  /** Seconds: when the store published these terms. */
  from: number;
  /** Seconds: when newer terms replaced them. */
  until?: number;
}

function sameTerms(left: OfferTerms, right: OfferTerms): boolean {
  return (
    left.d === right.d &&
    left.caip19 === right.caip19 &&
    left.payout === right.payout &&
    left.amount === right.amount
  );
}

/**
 * Record newly published terms for their product and coin: the standing terms
 * of that pair end at `until`, the new ones start at `from`. A setup dates the
 * new ones from before its first publish (a buyer may read them at once) and
 * ends the old ones after its last (a buyer may have read them until then), so
 * the two overlap while it runs. Publishing the same terms again changes nothing.
 */
export function publishTerms(
  periods: readonly TermsPeriod[],
  terms: OfferTerms,
  from: number,
  until: number,
): TermsPeriod[] {
  const standing = periods.find(
    (period) =>
      period.until === undefined &&
      period.terms.d === terms.d &&
      period.terms.caip19 === terms.caip19,
  );
  if (standing !== undefined && sameTerms(standing.terms, terms)) {
    return [...periods];
  }
  return [
    ...periods.map((period) =>
      period === standing ? { ...period, until: Math.max(until, period.from) } : period,
    ),
    { terms, from },
  ];
}

/**
 * End the standing terms of product `d` in every coin not in `offered`: a coin
 * dropped from its offer (or a product stopped) stops being payable once the
 * window after `until` has passed. Other products are untouched.
 */
export function retireTerms(
  periods: readonly TermsPeriod[],
  d: string,
  offered: readonly string[],
  until: number,
): TermsPeriod[] {
  return periods.map((period) =>
    period.until === undefined && period.terms.d === d && !offered.includes(period.terms.caip19)
      ? { ...period, until: Math.max(until, period.from) }
      : period,
  );
}

function distinct(periods: Iterable<TermsPeriod>): OfferTerms[] {
  const found: OfferTerms[] = [];
  for (const period of periods) {
    if (!found.some((terms) => sameTerms(terms, period.terms))) {
      found.push(period.terms);
    }
  }
  return found;
}

/**
 * Every set of terms of product `d` a payment made at `blockTime` may pay:
 * offered at some moment between `blockTime - TERMS_WINDOW_SECS` and
 * `blockTime`. The window hangs on the block time, which the chain sets - never
 * on the order's `created_at`, which the buyer signs: a back-dated order must
 * not reach an older, cheaper price. Only the order's own product counts: one
 * product's price never pays for another.
 */
export function termsAt(
  periods: readonly TermsPeriod[],
  d: string,
  blockTime: number,
): OfferTerms[] {
  const earliest = blockTime - TERMS_WINDOW_SECS;
  return distinct(
    periods.filter(
      (period) =>
        period.terms.d === d &&
        period.from <= blockTime &&
        (period.until === undefined || period.until > earliest),
    ),
  );
}

function inReach(period: TermsPeriod, since: number): boolean {
  return period.until === undefined || period.until > since - TERMS_WINDOW_SECS;
}

/** Every distinct set of terms of product `d` still in reach of a payment made at or after `since`. */
export function termsSince(
  periods: readonly TermsPeriod[],
  d: string,
  since: number,
): OfferTerms[] {
  return distinct(periods.filter((period) => period.terms.d === d && inReach(period, since)));
}

/**
 * Every product's terms still in reach of a payment made at or after `since`:
 * for the store-wide scans that only FIND candidate payments, each then checked
 * against its own order's product.
 */
export function termsSinceAll(periods: readonly TermsPeriod[], since: number): OfferTerms[] {
  return distinct(periods.filter((period) => inReach(period, since)));
}

/** The terms standing now: the newest of each product and coin, not yet replaced. */
export function standingTerms(periods: readonly TermsPeriod[]): OfferTerms[] {
  return periods.filter((period) => period.until === undefined).map((period) => period.terms);
}

/** One coin of a listing, at the listing's price in it. */
export interface ListingTerms {
  caip19: string;
  amount: string;
}

/** One coin of the payout list, and where it is paid. */
export interface PayoutTerms {
  caip19: string;
  payout: string;
}

/**
 * The terms of product `d` buyers can read: each coin of the listing they read
 * at its price there, paid to the payout list they read. A coin with no payout
 * cannot be paid.
 */
export function visibleTerms(
  d: string,
  listing: readonly ListingTerms[],
  payouts: readonly PayoutTerms[],
): OfferTerms[] {
  const visible: OfferTerms[] = [];
  for (const { caip19, amount } of listing) {
    const payout = payouts.find((terms) => terms.caip19 === caip19)?.payout;
    if (payout !== undefined) {
      visible.push({ d, caip19, payout, amount });
    }
  }
  return visible;
}
