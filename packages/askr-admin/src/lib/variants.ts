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

function keyOf(values: readonly string[]): string {
  return JSON.stringify(values);
}

/** Whether a variant already stands for this combination (`*` stands for any value). */
function covers(variant: VariantInput, values: readonly string[]): boolean {
  return values.every(
    (value, index) => variant.values[index] === ANY_OPTION_VALUE || variant.values[index] === value,
  );
}

export type VariantsFromOptions =
  | { ok: true; variants: VariantInput[] }
  | { ok: false; reason: string };

export interface RebuildVariants {
  /** The options the current variants were made for. */
  previous: readonly OptionInput[];
  /** The options now, each with a name and at least one value. */
  next: readonly OptionInput[];
  variants: readonly VariantInput[];
  /** Every variant this edit has seen, latest last: a combination that comes back gets its own back. */
  remembered: readonly VariantInput[];
  /** The price of a combination never seen before. */
  price: string;
}

/**
 * The variants after an options change, touching only what the change is about:
 * - the same number of options compares them by position, so renaming an option
 *   changes no variant; otherwise options are matched by name;
 * - a variant whose value is gone goes too; one with `*` or a remaining value stays,
 *   with its id, price and stock;
 * - a new option spreads each variant over its values (the first keeps the id);
 * - a new value adds the combinations it makes that no variant stands for yet;
 * - a product with no variants yet gets every combination.
 * A combination seen earlier in the edit comes back as it was; a new one gets `price`,
 * in stock, and a numeric id no variant of this edit has had.
 */
export function rebuildVariants(input: RebuildVariants): VariantsFromOptions {
  const { previous, next, variants, remembered, price } = input;
  if (next.length === 0) {
    return { ok: true, variants: [] };
  }
  if (next.some((option) => option.values.length === 0)) {
    return { ok: false, reason: 'Every option needs at least one value.' };
  }
  const grid = next.reduce((total, option) => total * option.values.length, 1);
  const overLimit = (count: number): VariantsFromOptions => ({
    ok: false,
    reason: `These options make ${count} combinations; a product holds at most ${LIMITS.MAX_VARIANTS} variants.`,
  });
  const byKey = new Map(remembered.map((variant) => [keyOf(variant.values), variant]));
  const taken = new Set([...remembered, ...variants].map((variant) => variant.id));
  let nextId = 1;
  const freshId = () => {
    while (taken.has(String(nextId))) {
      nextId += 1;
    }
    taken.add(String(nextId));
    return String(nextId);
  };
  const recalled = (values: string[], fallback: Omit<VariantInput, 'id' | 'values'>) =>
    byKey.get(keyOf(values)) ?? { id: freshId(), ...fallback, values };

  if (variants.length === 0) {
    if (grid > LIMITS.MAX_VARIANTS) {
      return overLimit(grid);
    }
    const all = combinations(next.map((option) => option.values)).map((values) =>
      recalled(values, { price, available: true }),
    );
    return { ok: true, variants: all };
  }

  // Which earlier option each option now is.
  const sources: (number | undefined)[] = [];
  if (previous.length === next.length) {
    next.forEach((_option, index) => sources.push(index));
  } else {
    const used = new Set<number>();
    for (const option of next) {
      const source = previous.findIndex(
        (earlier, index) => !used.has(index) && earlier.name === option.name,
      );
      if (source === -1) {
        sources.push(undefined);
      } else {
        used.add(source);
        sources.push(source);
      }
    }
  }

  const result: VariantInput[] = [];
  const seen = new Set<string>();
  const add = (variant: VariantInput) => {
    const key = keyOf(variant.values);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(variant);
    }
  };
  const newLists = next.map((option, index) =>
    sources[index] === undefined ? option.values : [ANY_OPTION_VALUE],
  );
  for (const variant of variants) {
    const projected = next.map((_option, index) => {
      const source = sources[index];
      return source === undefined ? undefined : variant.values[source];
    });
    const valid = projected.every(
      (value, index) =>
        value === undefined ||
        value === ANY_OPTION_VALUE ||
        (next[index]?.values.includes(value) ?? false),
    );
    if (!valid) {
      continue;
    }
    const spread = combinations(
      projected.map((value, index) => (value === undefined ? (newLists[index] ?? []) : [value])),
    );
    spread.forEach((values, spreadIndex) => {
      add(
        spreadIndex === 0
          ? { ...variant, values }
          : recalled(values, { price: variant.price, available: variant.available }),
      );
    });
  }

  next.forEach((option, index) => {
    const source = sources[index];
    if (source === undefined) {
      return;
    }
    const added = option.values.filter(
      (value) => !(previous[source]?.values ?? []).includes(value),
    );
    if (added.length === 0) {
      return;
    }
    const lists = next.map((other, otherIndex) => (otherIndex === index ? added : other.values));
    for (const values of combinations(lists)) {
      if (!result.some((variant) => covers(variant, values))) {
        add(recalled(values, { price, available: true }));
      }
    }
  });

  if (result.length > LIMITS.MAX_VARIANTS) {
    return overLimit(result.length);
  }
  const rank = (values: readonly string[]) =>
    values.map((value, index) =>
      value === ANY_OPTION_VALUE ? -1 : (next[index]?.values.indexOf(value) ?? -1),
    );
  result.sort((left, right) => {
    const leftRank = rank(left.values);
    const rightRank = rank(right.values);
    const differs = leftRank.findIndex((value, index) => value !== rightRank[index]);
    return differs === -1 ? 0 : (leftRank[differs] ?? 0) - (rightRank[differs] ?? 0);
  });
  return { ok: true, variants: result };
}
