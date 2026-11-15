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

/** An option with the identity of its editor row, so a rename or a removal is never guessed. */
export interface KeyedOption {
  key: string;
  name: string;
  values: string[];
}

/** A variant's values by option key. */
type Assignment = ReadonlyMap<string, string>;

function assignmentOf(options: readonly KeyedOption[], values: readonly string[]): Assignment {
  return new Map(options.map((option, index) => [option.key, values[index] ?? '']));
}

function assignmentKey(assignment: Assignment): string {
  return JSON.stringify(
    [...assignment.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

/** The key a variant of `options` with these values is remembered under. */
export function rememberedKey(options: readonly KeyedOption[], values: readonly string[]): string {
  return assignmentKey(assignmentOf(options, values));
}

/** Two variants overlap when every option they share has equal values or a `*`. */
function overlaps(left: Assignment, right: Assignment): boolean {
  for (const [key, value] of left) {
    const other = right.get(key);
    if (
      other !== undefined &&
      value !== ANY_OPTION_VALUE &&
      other !== ANY_OPTION_VALUE &&
      value !== other
    ) {
      return false;
    }
  }
  return true;
}

export type VariantsFromOptions =
  | { ok: true; variants: VariantInput[] }
  | { ok: false; reason: string };

export interface RebuildVariants {
  /** The options the current variants were made for, in order. */
  previous: readonly KeyedOption[];
  /** The options now, each with a name and at least one value, in order. */
  next: readonly KeyedOption[];
  variants: readonly VariantInput[];
  /** Every variant this edit has seen, by `rememberedKey`: a combination that comes back gets its own back. */
  remembered: ReadonlyMap<string, VariantInput>;
  /** The price of a combination never seen before. */
  price: string;
}

interface Built {
  assignment: Assignment;
  variant: Omit<VariantInput, 'values'>;
}

/**
 * The variants after an options change, matched by the options' row keys:
 * - a renamed option changes no variant;
 * - a variant whose value is gone goes; a removed option merges the variants it
 *   told apart (the first of overlapping ones stays);
 * - a new option spreads each variant over its values (the first keeps the id);
 * - a new value adds the combinations it makes that no variant (counting `*`)
 *   stands for yet;
 * - a product that had no options gets every combination; one that had options
 *   and no variants (a connector cut them) keeps none.
 * A combination seen earlier in the edit comes back with its price and stock,
 * and its id unless another combination holds it now; a new one gets `price`,
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
  if (previous.length > 0 && variants.length === 0) {
    return { ok: true, variants: [] };
  }
  const overLimit = (count: number): VariantsFromOptions => ({
    ok: false,
    reason: `These options make ${count} combinations; a product holds at most ${LIMITS.MAX_VARIANTS} variants.`,
  });
  const taken = new Set([...remembered.values(), ...variants].map((variant) => variant.id));
  const used = new Set<string>();
  let nextId = 1;
  const freshId = () => {
    while (taken.has(String(nextId)) || used.has(String(nextId))) {
      nextId += 1;
    }
    taken.add(String(nextId));
    return String(nextId);
  };
  const built: Built[] = [];
  /** A remembered combination first, else `fallback` (an `id` of its own only for the first spread copy). */
  const place = (
    assignment: Assignment,
    fallback: { id?: string; price: string; available: boolean } | undefined,
  ) => {
    const known = remembered.get(assignmentKey(assignment));
    const source = known ?? fallback;
    const ownId = source?.id;
    const id = ownId !== undefined && !used.has(ownId) ? ownId : freshId();
    used.add(id);
    built.push({
      assignment,
      variant: {
        id,
        price: source?.price ?? price,
        available: source?.available ?? true,
      },
    });
  };

  if (previous.length === 0) {
    const grid = next.reduce((total, option) => total * option.values.length, 1);
    if (grid > LIMITS.MAX_VARIANTS) {
      return overLimit(grid);
    }
    for (const values of combinations(next.map((option) => option.values))) {
      place(assignmentOf(next, values), undefined);
    }
  } else {
    const nextByKey = new Map(next.map((option) => [option.key, option]));
    const previousKeys = new Set(previous.map((option) => option.key));
    const merging = previous.some((option) => !nextByKey.has(option.key));
    const kept: { assignment: Map<string, string>; variant: VariantInput }[] = [];
    for (const variant of variants) {
      const assignment = new Map<string, string>();
      let valid = true;
      assignmentOf(previous, variant.values).forEach((value, key) => {
        const option = nextByKey.get(key);
        if (option === undefined) {
          return;
        }
        if (value !== ANY_OPTION_VALUE && !option.values.includes(value)) {
          valid = false;
        }
        assignment.set(key, value);
      });
      // Only a removed option makes new overlaps; variants that overlapped before stay as they are.
      if (valid && !(merging && kept.some((other) => overlaps(other.assignment, assignment)))) {
        kept.push({ assignment, variant });
      }
    }
    const added = next.filter((option) => !previousKeys.has(option.key));
    for (const { assignment, variant } of kept) {
      const spread = combinations(added.map((option) => option.values));
      spread.forEach((values, spreadIndex) => {
        const full = new Map(assignment);
        added.forEach((option, index) => full.set(option.key, values[index] ?? ''));
        place(
          full,
          spreadIndex === 0 ? variant : { price: variant.price, available: variant.available },
        );
      });
    }
    for (const option of next) {
      const before = previous.find((earlier) => earlier.key === option.key);
      if (before === undefined) {
        continue;
      }
      const newValues = option.values.filter((value) => !before.values.includes(value));
      if (newValues.length === 0) {
        continue;
      }
      const lists = next.map((other) => (other.key === option.key ? newValues : other.values));
      for (const values of combinations(lists)) {
        const assignment = assignmentOf(next, values);
        if (!built.some((existing) => overlaps(existing.assignment, assignment))) {
          place(assignment, undefined);
        }
      }
    }
  }

  if (built.length > LIMITS.MAX_VARIANTS) {
    return overLimit(built.length);
  }
  const result = built.map(({ assignment, variant }) => ({
    ...variant,
    values: next.map((option) => assignment.get(option.key) ?? ''),
  }));
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
