import { type CatalogItemInput, LIMITS } from '@elisym/askr';
import Decimal from 'decimal.js-light';

export type VariantInput = NonNullable<CatalogItemInput['variants']>[number];
export type OptionInput = NonNullable<CatalogItemInput['options']>[number];

const PRICE_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;

/**
 * The listing price a product with variants must carry (2.1): the lowest
 * available variant's, or the lowest overall when none is available.
 * Undefined with no variants or a price that is not a plain number.
 */
export function listingPriceOf(variants: readonly VariantInput[]): string | undefined {
  if (variants.length === 0 || !variants.every((variant) => PRICE_RE.test(variant.price))) {
    return undefined;
  }
  const available = variants.filter((variant) => variant.available);
  const pool = available.length > 0 ? available : variants;
  let lowest = pool[0];
  for (const variant of pool) {
    if (lowest === undefined || new Decimal(variant.price).lessThan(lowest.price)) {
      lowest = variant;
    }
  }
  return lowest?.price;
}

/** `S, M, L` as option values: trimmed, empty ones dropped, each once. */
export function optionValuesOf(text: string): string[] {
  const values: string[] = [];
  for (const entry of text.split(',')) {
    const value = entry.trim();
    if (value !== '' && !values.includes(value)) {
      values.push(value);
    }
  }
  return values;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Every combination of the options' values, in option order. */
function combinations(options: readonly OptionInput[]): string[][] {
  let rows: string[][] = [[]];
  for (const option of options) {
    rows = rows.flatMap((row) => option.values.map((value) => [...row, value]));
  }
  return rows;
}

export type VariantsFromOptions =
  | { ok: true; variants: VariantInput[] }
  | { ok: false; reason: string };

/**
 * One variant per combination of the options' values. A combination that
 * already had a variant keeps its id, price and availability; a new one gets
 * `price` and the next numeric id that is neither in `existing` nor in
 * `retired` (ids once published for another combination).
 */
export function variantsFromOptions(
  options: readonly OptionInput[],
  existing: readonly VariantInput[],
  price: string,
  retired: ReadonlySet<string> = new Set(),
): VariantsFromOptions {
  if (options.length === 0) {
    return { ok: true, variants: [] };
  }
  const count = options.reduce((total, option) => total * option.values.length, 1);
  if (count === 0) {
    return { ok: false, reason: 'Every option needs at least one value.' };
  }
  if (count > LIMITS.MAX_VARIANTS) {
    return {
      ok: false,
      reason: `These options make ${count} combinations; a product holds at most ${LIMITS.MAX_VARIANTS} variants.`,
    };
  }
  const taken = new Set([...retired, ...existing.map((variant) => variant.id)]);
  let next = 1;
  const freshId = () => {
    while (taken.has(String(next))) {
      next += 1;
    }
    taken.add(String(next));
    return String(next);
  };
  const variants = combinations(options).map((values) => {
    const kept = existing.find((variant) => sameValues(variant.values, values));
    return kept ?? { id: freshId(), price, available: true, values };
  });
  return { ok: true, variants };
}
