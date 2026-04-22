import { resolveKnownAsset, type CapabilityCard } from '@elisym/sdk';
import Decimal from 'decimal.js-light';

type PaymentInfo = NonNullable<CapabilityCard['payment']>;

/**
 * Subscript digits used by `compactZeros` to compress long runs of leading
 * zeros (e.g. `0.0000052 SOL` → `0.0₄52 SOL`). Indexed by their numeric value.
 */
const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'] as const;

/**
 * Compress at least `threshold` leading zeros after the decimal point into a
 * `0.0<subscript>` form. Used to keep very small SOL network fees readable
 * (e.g. `~0.0000052 SOL` → `~0.0₄52 SOL`) without losing precision.
 *
 * Expects a decimal string produced by `Decimal.toString()` - no rounding, no
 * exponential form. Values with `< threshold` leading zeros or no fractional
 * part are returned untouched so normal prices like `0.01 SOL` render plainly.
 */
export function compactZeros(value: string, threshold = 4): string {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const dotIdx = body.indexOf('.');
  if (dotIdx === -1) {
    return value;
  }
  const whole = body.slice(0, dotIdx);
  const frac = body.slice(dotIdx + 1);
  if (whole !== '0') {
    return value;
  }
  let leadingZeros = 0;
  while (leadingZeros < frac.length && frac[leadingZeros] === '0') {
    leadingZeros += 1;
  }
  // Either not small enough to bother or the value is exactly zero.
  if (leadingZeros < threshold || leadingZeros === frac.length) {
    return value;
  }
  const rest = frac.slice(leadingZeros);
  const subscript = toSubscript(leadingZeros - 1);
  return `${negative ? '-' : ''}0.0${subscript}${rest}`;
}

function toSubscript(n: number): string {
  return n
    .toString()
    .split('')
    .map((ch) => SUBSCRIPT_DIGITS[Number(ch)])
    .join('');
}

/**
 * Format a raw subunit price using the card's declared asset.
 *
 * All arithmetic goes through `decimal.js-light` - JS floats cannot represent
 * 6-decimal USDC safely, and `Decimal.toString()` gives us trailing-zero
 * trimming for free (so 50_000 of USDC renders as "0.05 USDC", not
 * "0.050000 USDC"). See the repo CLAUDE.md rule on numeric work.
 *
 * Defaults to SOL when the card omits `token` - back-compat for capability
 * cards published before multi-asset support. Unknown asset combinations fall
 * back to a bare lamport / subunit display rather than blanking the UI.
 */
export function formatCardPrice(payment: PaymentInfo | undefined, amount: number): string {
  const fallbackToken = 'SOL';
  const fallbackDecimals = 9;

  if (!payment || !payment.token || payment.token === 'sol') {
    return `${compactZeros(formatDecimal(amount, fallbackDecimals))} ${fallbackToken}`;
  }
  const asset = resolveKnownAsset(payment.chain, payment.token, payment.mint);
  if (!asset) {
    return `${amount} ${payment.symbol ?? payment.token.toUpperCase()}`;
  }
  return `${compactZeros(formatDecimal(amount, asset.decimals))} ${asset.symbol}`;
}

/**
 * Convert raw subunits to a Decimal-string representation of the whole-unit
 * amount (e.g. lamports → SOL). All elisym app numeric work goes through
 * `decimal.js-light`; see the CLAUDE.md rule on numeric work.
 */
export function formatDecimal(amount: number, decimals: number): string {
  return new Decimal(amount).div(new Decimal(10).pow(decimals)).toString();
}
