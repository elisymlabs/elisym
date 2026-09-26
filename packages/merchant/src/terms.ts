import { TERMS_WINDOW_SECS } from './constants';

/** What the store asked for one product in one coin: pay `amount` to `payout`. */
export interface OfferTerms {
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
    left.caip19 === right.caip19 && left.payout === right.payout && left.amount === right.amount
  );
}

/**
 * Record newly published terms for their coin: the standing terms of that coin
 * end now. Publishing the same terms again changes nothing.
 */
export function publishTerms(
  periods: readonly TermsPeriod[],
  terms: OfferTerms,
  at: number,
): TermsPeriod[] {
  const standing = periods.find(
    (period) => period.until === undefined && period.terms.caip19 === terms.caip19,
  );
  if (standing !== undefined && sameTerms(standing.terms, terms)) {
    return [...periods];
  }
  return [
    ...periods.map((period) =>
      period === standing ? { ...period, until: Math.max(at, period.from) } : period,
    ),
    { terms, from: at },
  ];
}

/**
 * End the standing terms of every coin not in `offered`: a coin dropped from the
 * offer stops being payable once the window after `at` has passed.
 */
export function retireTerms(
  periods: readonly TermsPeriod[],
  offered: readonly string[],
  at: number,
): TermsPeriod[] {
  return periods.map((period) =>
    period.until === undefined && !offered.includes(period.terms.caip19)
      ? { ...period, until: Math.max(at, period.from) }
      : period,
  );
}

/**
 * Every set of terms a payment made at `blockTime` may pay: offered at some
 * moment between `blockTime - TERMS_WINDOW_SECS` and `blockTime`. The window
 * hangs on the block time, which the chain sets - never on the order's
 * `created_at`, which the buyer signs: a back-dated order must not reach an
 * older, cheaper price.
 */
export function termsAt(periods: readonly TermsPeriod[], blockTime: number): OfferTerms[] {
  const earliest = blockTime - TERMS_WINDOW_SECS;
  const found: OfferTerms[] = [];
  for (const period of periods) {
    const offered =
      period.from <= blockTime && (period.until === undefined || period.until > earliest);
    if (offered && !found.some((terms) => sameTerms(terms, period.terms))) {
      found.push(period.terms);
    }
  }
  return found;
}

/** Every distinct set of terms still in reach of a payment made at or after `since`. */
export function termsSince(periods: readonly TermsPeriod[], since: number): OfferTerms[] {
  const earliest = since - TERMS_WINDOW_SECS;
  const found: OfferTerms[] = [];
  for (const period of periods) {
    if (
      (period.until === undefined || period.until > earliest) &&
      !found.some((terms) => sameTerms(terms, period.terms))
    ) {
      found.push(period.terms);
    }
  }
  return found;
}
