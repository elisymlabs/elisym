import {
  ANY_OPTION_VALUE,
  type CatalogItemInput,
  LIMITS,
  PRICE_AMOUNT_RE,
  type VariantInput,
} from '@elisym/askr';

export { listingPriceOf, type VariantInput } from '@elisym/askr';
export type OptionInput = NonNullable<CatalogItemInput['options']>[number];

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
  if (options.length === 0 || grid === 0 || options.some((option) => option.name === '')) {
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

/**
 * What keeps these variants from being saved with these options, in plain
 * words. `initial` are the variants the product came with: two that overlapped
 * there already (a connector's "any size" next to "size S") may keep
 * overlapping, and a product without options may keep its one variant.
 */
export function variantProblems(
  options: readonly OptionInput[],
  variants: readonly VariantInput[],
  initial: readonly VariantInput[] = [],
): string[] {
  if (variants.length === 0) {
    return [];
  }
  const name = (variant: VariantInput, index: number) =>
    `Variant ${index + 1} (${variantLabel(variant.values)})`;
  const problems: string[] = [];
  variants.forEach((variant, index) => {
    if (!PRICE_AMOUNT_RE.test(variant.price)) {
      problems.push(`${name(variant, index)}: the price is not a number like 19.90.`);
    }
  });
  if (options.length === 0) {
    if (variants.length > 1) {
      problems.push(
        'Several variants need an option to tell them apart: add one, or remove variants.',
      );
    }
    return problems;
  }
  variants.forEach((variant, index) => {
    options.forEach((option, optionIndex) => {
      const value = variant.values[optionIndex] ?? '';
      if (option.name === '' || option.values.length === 0) {
        // The option itself is reported; its variants' choices wait for it.
        return;
      }
      if (value === '') {
        problems.push(`${name(variant, index)}: pick its ${option.name}.`);
      } else if (value !== ANY_OPTION_VALUE && !option.values.includes(value)) {
        problems.push(
          `${name(variant, index)} uses ${value}, which ${option.name} no longer has: pick another value or remove the variant.`,
        );
      }
    });
  });
  // A pair the product came with overlapping, told by id and still in the same shape: the
  // same values equal between them and the same `*`s, so a renamed value keeps it but moving
  // the pair onto another choice does not.
  const sameShape = (
    now: readonly string[],
    before: readonly string[],
    other: readonly string[],
    otherBefore: readonly string[],
  ) =>
    now.length === before.length &&
    now.every(
      (value, index) =>
        (value === ANY_OPTION_VALUE) === (before[index] === ANY_OPTION_VALUE) &&
        (value === other[index]) === (before[index] === otherBefore[index]),
    );
  const cameOverlapping = (left: VariantInput, right: VariantInput) => {
    const leftBefore = initial.find((kept) => kept.id === left.id);
    const rightBefore = initial.find((kept) => kept.id === right.id);
    return (
      leftBefore !== undefined &&
      rightBefore !== undefined &&
      overlaps(leftBefore.values, rightBefore.values) &&
      sameShape(left.values, leftBefore.values, right.values, rightBefore.values) &&
      sameShape(right.values, rightBefore.values, left.values, leftBefore.values)
    );
  };
  variants.forEach((variant, index) => {
    variants.forEach((other, otherIndex) => {
      if (
        otherIndex <= index ||
        variant.values.some((value) => value === '') ||
        other.values.some((value) => value === '') ||
        !overlaps(variant.values, other.values) ||
        cameOverlapping(variant, other)
      ) {
        return;
      }
      problems.push(
        `${name(variant, index)} and ${name(other, otherIndex)} are the same choice for a shopper (Any stands for every value): change one or remove it.`,
      );
    });
  });
  if (variants.length > LIMITS.MAX_VARIANTS) {
    problems.push(`A product holds at most ${LIMITS.MAX_VARIANTS} variants.`);
  }
  return problems;
}
