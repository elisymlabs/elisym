import { ANY_OPTION_VALUE, type CatalogItemInput, LIMITS } from '@elisym/askr';
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

/**
 * `S, M, L` as option values: trimmed, empty ones dropped, each once. `*`
 * means "any value" in a variant, so it is never an option value.
 */
export function optionValuesOf(text: string): string[] {
  const values: string[] = [];
  for (const entry of text.split(',')) {
    const value = entry.trim();
    if (value !== '' && value !== ANY_OPTION_VALUE && !values.includes(value)) {
      values.push(value);
    }
  }
  return values;
}

/** Every combination of these value lists, in order. */
function combinations(lists: readonly (readonly string[])[]): string[][] {
  let rows: string[][] = [[]];
  for (const values of lists) {
    rows = rows.flatMap((row) => values.map((value) => [...row, value]));
  }
  return rows;
}

/** Two variants overlap when each option has equal values or a `*` on either side. */
function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.every(
    (value, index) =>
      value === right[index] || value === ANY_OPTION_VALUE || right[index] === ANY_OPTION_VALUE,
  );
}

/** A variant as a shopper reads it: `M / Red`, `Any` for `*`, `?` for no value yet. */
export function variantLabel(values: readonly string[]): string {
  return values
    .map((value) => {
      if (value === ANY_OPTION_VALUE) {
        return 'Any';
      }
      return value === '' ? '?' : value;
    })
    .join(' / ');
}

/**
 * The value an edit of one option's values renamed: the same number of values
 * with exactly one changed in place (`Navy` to `Navy blue`, letter by letter).
 * Anything else (a value added, removed or reordered) renames nothing.
 */
export function renamedValue(
  before: readonly string[],
  after: readonly string[],
): { from: string; to: string } | undefined {
  if (before.length !== after.length) {
    return undefined;
  }
  const changed = before.flatMap((value, index) => (value === after[index] ? [] : [index]));
  const [index] = changed;
  if (changed.length !== 1 || index === undefined) {
    return undefined;
  }
  const from = before[index];
  const to = after[index];
  return from === undefined || to === undefined ? undefined : { from, to };
}

/** Above this many combinations the options are not even walked. */
const MAX_COMBINATIONS_WALKED = 10_000;

export type MissingCombinations =
  | { ok: true; variants: VariantInput[] }
  | { ok: false; reason: string };

/**
 * The variants plus one for every combination of the options' values that no
 * variant (counting `*`) stands for yet, at `price` and in stock, with ids
 * from `freshId`.
 */
export function withMissingCombinations(
  options: readonly OptionInput[],
  variants: readonly VariantInput[],
  price: string,
  freshId: () => string,
): MissingCombinations {
  const grid = options.reduce((total, option) => total * option.values.length, 1);
  const overLimit = (count: number): MissingCombinations => ({
    ok: false,
    reason: `These options make ${count} combinations; a product holds at most ${LIMITS.MAX_VARIANTS} variants.`,
  });
  if (options.length === 0 || grid === 0) {
    return { ok: false, reason: 'Every option needs a name and at least one value first.' };
  }
  if (grid > MAX_COMBINATIONS_WALKED) {
    return overLimit(grid);
  }
  const missing = combinations(options.map((option) => option.values)).filter(
    (values) => !variants.some((variant) => overlaps(variant.values, values)),
  );
  if (variants.length + missing.length > LIMITS.MAX_VARIANTS) {
    return overLimit(variants.length + missing.length);
  }
  return {
    ok: true,
    variants: [
      ...variants,
      ...missing.map((values) => ({ id: freshId(), price, available: true, values })),
    ],
  };
}

/** What keeps these variants from being saved with these options, in plain words. */
export function variantProblems(
  options: readonly OptionInput[],
  variants: readonly VariantInput[],
): string[] {
  if (variants.length === 0) {
    return [];
  }
  if (options.length === 0) {
    return ['Variants need an option: add one, or remove the variants.'];
  }
  const problems: string[] = [];
  variants.forEach((variant, index) => {
    options.forEach((option, optionIndex) => {
      const value = variant.values[optionIndex] ?? '';
      if (option.name === '' || option.values.length === 0) {
        // The option itself is reported; its variants' choices wait for it.
        return;
      }
      if (value === '') {
        problems.push(
          `Variant ${index + 1} (${variantLabel(variant.values)}): pick its ${option.name}.`,
        );
      } else if (value !== ANY_OPTION_VALUE && !option.values.includes(value)) {
        problems.push(
          `Variant ${variantLabel(variant.values)} uses ${value}, which ${option.name} no longer has: pick another value or remove the variant.`,
        );
      }
    });
  });
  variants.forEach((variant, index) => {
    const later = variants.slice(index + 1).find((other) => overlaps(variant.values, other.values));
    if (later !== undefined && variant.values.every((value) => value !== '')) {
      problems.push(
        `Variants ${variantLabel(variant.values)} and ${variantLabel(later.values)} are the same choice for a shopper (Any stands for every value): change one or remove it.`,
      );
    }
  });
  if (variants.length > LIMITS.MAX_VARIANTS) {
    problems.push(`A product holds at most ${LIMITS.MAX_VARIANTS} variants.`);
  }
  return problems;
}
