import Decimal from 'decimal.js-light';

const BPS_PER_WHOLE = 10_000;

/** `used` of `limit` in basis points, capped at 100 %; zero when the limit is zero or unreadable. */
export function shareBps(used: string | number, limit: string | number): number {
  try {
    const total = new Decimal(limit);
    if (total.lessThanOrEqualTo(0)) {
      return 0;
    }
    const share = new Decimal(used)
      .times(BPS_PER_WHOLE)
      .dividedBy(total)
      .toDecimalPlaces(0, Decimal.ROUND_DOWN);
    return Math.min(BPS_PER_WHOLE, Math.max(0, share.toNumber()));
  } catch {
    return 0;
  }
}

/** Basis points as a percent string with up to two decimals: 1234 -> "12.34". */
export function percentOfBps(bps: number): string {
  return new Decimal(bps).dividedBy(100).toString();
}

/** A USD decimal string for display, to the cent. */
export function usd(amount: string): string {
  try {
    return `$${new Decimal(amount).toFixed(2)}`;
  } catch {
    return `$${amount}`;
  }
}
