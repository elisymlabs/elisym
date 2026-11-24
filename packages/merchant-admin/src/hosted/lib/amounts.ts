/**
 * Coin amounts as the merchant types and reads them, against the integer
 * subunits the server keeps: every step in `decimal.js-light`, by the coin's
 * own decimals from the registry, never a float.
 */
import { parseCaip19 } from '@elisym/commerce';
import { explorerTxUrl } from '@elisym/pay-core';
import Decimal from 'decimal.js-light';

/** Wide enough for 39 integer digits (the server's refund bound) plus 18 decimals, printed plainly. */
const AmountDecimal = Decimal.clone({ precision: 100, toExpNeg: -100, toExpPos: 100 });

/** The server's refund amount: 1 to 39 digits, no leading zero (`REFUND_AMOUNT_RE`). */
export const MAX_SUBUNIT_DIGITS = 39;

const TYPED_AMOUNT_RE = /^\d+(?:\.\d+)?$/;

export type AmountProblem = 'format' | 'negative' | 'zero' | 'decimals' | 'large';

export type SubunitsOutcome =
  | { ok: true; subunits: string }
  | { ok: false; problem: AmountProblem };

/** A coin amount typed in whole units (`1.5`) as integer subunits of a coin with `decimals`. */
export function toSubunits(typed: string, decimals: number): SubunitsOutcome {
  const text = typed.trim();
  if (text.startsWith('-')) {
    return { ok: false, problem: 'negative' };
  }
  if (!TYPED_AMOUNT_RE.test(text)) {
    return { ok: false, problem: 'format' };
  }
  const subunits = new AmountDecimal(text).times(new AmountDecimal(10).pow(decimals));
  if (!subunits.isInteger()) {
    return { ok: false, problem: 'decimals' };
  }
  if (subunits.isZero()) {
    return { ok: false, problem: 'zero' };
  }
  const digits = subunits.toFixed(0);
  if (digits.length > MAX_SUBUNIT_DIGITS) {
    return { ok: false, problem: 'large' };
  }
  return { ok: true, subunits: digits };
}

/** Integer subunits of a coin with `decimals`, in whole units (`1500000`, 6 -> `1.5`). */
export function fromSubunits(subunits: string, decimals: number): string {
  return new AmountDecimal(subunits).div(new AmountDecimal(10).pow(decimals)).toString();
}

/** The decimals of a coin the registry knows. */
export function coinDecimals(caip19: string): number | undefined {
  return parseCaip19(caip19)?.asset.decimals;
}

/** `amount` subunits of `caip19` as `1.5 USDC`; the raw subunits when the registry does not know the coin. */
export function coinAmountText(amount: string, caip19: string): string {
  const parsed = parseCaip19(caip19);
  return parsed === undefined
    ? `${amount} subunits`
    : `${fromSubunits(amount, parsed.asset.decimals)} ${parsed.asset.symbol}`;
}

/** The explorer page of `tx` on the coin's chain (`TxLink` links it only when it is https), or none. */
export function txExplorer(caip19: string, tx: string): string | undefined {
  const parsed = parseCaip19(caip19);
  return parsed === undefined ? undefined : explorerTxUrl(parsed.chain, tx);
}
