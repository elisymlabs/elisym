import Decimal from 'decimal.js-light';

/** Nine decimals at most: the database keeps USD as `numeric(20, 9)`. */
const USD_RE = /^\d{1,9}(\.\d{1,9})?$/;
/** One turn's reservation and spend ceiling unless the environment says otherwise (5.8). */
export const DEFAULT_TURN_RESERVE_USD = '0.25';

/** A USD amount from the environment: a plain decimal above zero, checked at start, not on the first ask. */
export function positiveUsd(name: string, value: string): string {
  if (!USD_RE.test(value) || new Decimal(value).lessThanOrEqualTo(0)) {
    throw new Error(`${name} must be a decimal above zero, got ${value}`);
  }
  return value;
}

/** The public base NIP-98 `u` is compared with (7.3), without a trailing slash. */
export function publicBaseOf(value: string): string {
  return value.replace(/\/+$/u, '');
}
