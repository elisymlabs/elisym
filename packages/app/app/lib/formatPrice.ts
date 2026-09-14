import { resolveKnownAsset, type CapabilityCard } from '@elisym/sdk';
import Decimal from 'decimal.js-light';
import { resolvePaymentAsset } from './cardAsset';
import { SOLANA_CLUSTER } from './cluster';

type PaymentInfo = NonNullable<CapabilityCard['payment']>;

// Cloned config keeps `Decimal.toString()` from switching to exponential
// notation for small fractional amounts (1 lamport = 1e-9 SOL). `compactZeros`
// only rewrites decimal notation, so an exponential string would slip through
// it untouched and surface as "1e-9 SOL". Mirrors `formatAssetAmount` in the SDK.
const FormatDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 50 });

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
  // Exact (chain, token, mint) first so a card minted on the other cluster still
  // renders in its own decimals; a card that omits `mint` cannot be keyed that
  // way, so fall back to this page's cluster - otherwise the price would print
  // in raw subunits next to an affordability tooltip that reads whole units.
  const asset =
    resolveKnownAsset(payment.chain, payment.token, payment.mint) ??
    resolvePaymentAsset(payment, SOLANA_CLUSTER);
  if (!asset) {
    return `${amount} ${payment.symbol ?? payment.token.toUpperCase()}`;
  }
  return `${compactZeros(formatDecimal(amount, asset.decimals))} ${asset.symbol}`;
}

/**
 * Render a capability card's price the way the card actually prices.
 *
 * A METERED card charges what the job consumed, so its `job_price` is the
 * CEILING and a flat number would overstate the usual cost several-fold. Those
 * cards render as a range instead.
 *
 * `metered` is only reachable through the delegated rail, so a caller that
 * knows the buy is per-job passes `allowRange: false` and gets the flat ceiling
 * - which is exactly what that rail collects.
 *
 * Returns `null` for a free or price-less card, so callers can skip the label.
 */
export function formatCardPriceLabel(
  card: Pick<CapabilityCard, 'payment' | 'metered'>,
  opts: { allowRange?: boolean } = {},
): string | null {
  const price = card.payment?.job_price;
  if (price === null || price === undefined || price === 0) {
    return null;
  }
  const min = card.metered?.min_subunits;
  // Requires an explicit `true`: the range is only reachable on the delegated
  // rail, so a caller that forgets the flag must get the flat ceiling rather
  // than silently under-display a price the buyer may not be able to reach.
  if (min === undefined || opts.allowRange !== true) {
    return formatCardPrice(card.payment, price);
  }
  // A floor equal to the ceiling is a legal, operator-configurable degenerate
  // case (the card parser keeps it deliberately). Rendering "0.05 - 0.05" reads
  // like a bug; it is simply a flat price.
  const minNumber = Number(min);
  if (minNumber === price) {
    return formatCardPrice(card.payment, price);
  }
  return `${formatCardPrice(card.payment, minNumber)} - ${formatCardPrice(card.payment, price)}`;
}

/**
 * Decide whether a provider-reported settled amount may replace the price
 * stamped on a thread entry.
 *
 * Three conditions, and every one of them is load-bearing:
 *  - the buy must have gone through the DELEGATED rail. On the ordinary rail
 *    the buyer signs the ceiling but the provider's tag is the NET (price minus
 *    protocol fee), which sits inside the window and would silently record less
 *    than the wallet actually sent.
 *  - the card must be metered, or there is nothing variable to correct.
 *  - the figure must land inside the range the card published and the buyer
 *    approved. Outside it, the stamped ceiling stands.
 */
export function settledPriceForEntry(
  card: Pick<CapabilityCard, 'payment' | 'metered'>,
  opts: { delegated: boolean; reported: number | undefined },
): number | null {
  if (!opts.delegated) {
    return null;
  }
  const min = card.metered?.min_subunits;
  const ceiling = card.payment?.job_price;
  if (min === undefined || ceiling === undefined || opts.reported === undefined) {
    return null;
  }
  if (!Number.isInteger(opts.reported)) {
    return null;
  }
  return opts.reported >= Number(min) && opts.reported <= ceiling ? opts.reported : null;
}

/**
 * Whether a relay-reported amount is plausible enough to render as a price.
 *
 * Nothing here can make it TRUE - only the provider knows what its pull moved -
 * so this is a floor on nonsense, not a guarantee. `> 0` rather than `>= 0`
 * because a zero price renders as "Free", and a provider tagging zero would
 * make a paid job read as free.
 */
export function plausibleReportedPrice(amount: number | undefined): number | null {
  if (amount === undefined || !Number.isInteger(amount) || amount <= 0) {
    return null;
  }
  return amount;
}

/**
 * Convert raw subunits to a Decimal-string representation of the whole-unit
 * amount (e.g. lamports → SOL). All elisym app numeric work goes through
 * `decimal.js-light`; see the CLAUDE.md rule on numeric work.
 */
export function formatDecimal(amount: number, decimals: number): string {
  return new FormatDecimal(amount).div(new FormatDecimal(10).pow(decimals)).toString();
}
