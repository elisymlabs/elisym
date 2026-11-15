import { describe, expect, it } from 'vitest';
import {
  type KeyedOption,
  type VariantInput,
  listingPriceOf,
  optionValuesOf,
  rebuildVariants,
  rememberedKey,
} from '../src/lib/variants';

describe('listingPriceOf', () => {
  it('is the lowest in-stock variant price, compared as decimals', () => {
    expect(
      listingPriceOf([
        { id: '1', price: '9.5', available: true, values: ['S'] },
        { id: '2', price: '10', available: true, values: ['M'] },
        { id: '3', price: '2', available: false, values: ['L'] },
      ]),
    ).toBe('9.5');
    expect(
      listingPriceOf([
        { id: '1', price: '0.30', available: true, values: ['S'] },
        { id: '2', price: '0.3', available: true, values: ['M'] },
        { id: '3', price: '0.299999999999999999', available: true, values: ['L'] },
      ]),
    ).toBe('0.299999999999999999');
  });

  it('is the lowest overall when nothing is in stock, undefined with no variants or a bad price', () => {
    expect(
      listingPriceOf([
        { id: '1', price: '12', available: false, values: ['S'] },
        { id: '2', price: '11', available: false, values: ['M'] },
      ]),
    ).toBe('11');
    expect(listingPriceOf([])).toBeUndefined();
    expect(
      listingPriceOf([
        { id: '1', price: '12', available: true, values: ['S'] },
        { id: '2', price: '1,5', available: true, values: ['M'] },
      ]),
    ).toBeUndefined();
  });
});

describe('optionValuesOf', () => {
  it('splits on commas, trims, drops empty and repeated values', () => {
    expect(optionValuesOf(' S, M,,M , L ,')).toEqual(['S', 'M', 'L']);
    expect(optionValuesOf('')).toEqual([]);
    // `*` means any value in a variant: never an option value.
    expect(optionValuesOf('S, *, M')).toEqual(['S', 'M']);
  });
});

const SIZE = (values: string[]): KeyedOption => ({ key: 'size', name: 'Size', values });
const COLOR = (values: string[]): KeyedOption => ({ key: 'color', name: 'Color', values });
const FIT = (values: string[]): KeyedOption => ({ key: 'fit', name: 'Fit', values });

function memory(
  options: readonly KeyedOption[],
  variants: readonly VariantInput[],
): Map<string, VariantInput> {
  return new Map(variants.map((variant) => [rememberedKey(options, variant.values), variant]));
}

function rebuilt(
  previous: KeyedOption[],
  next: KeyedOption[],
  variants: VariantInput[],
  remembered: ReadonlyMap<string, VariantInput> = memory(previous, variants),
): VariantInput[] {
  const result = rebuildVariants({ previous, next, variants, remembered, price: '20' });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.variants;
}

const GRID: VariantInput[] = [
  { id: 'a', price: '1', available: true, values: ['S', 'Red'] },
  { id: 'b', price: '2', available: false, values: ['S', 'Blue'] },
  { id: 'c', price: '3', available: true, values: ['M', 'Red'] },
  { id: 'd', price: '4', available: true, values: ['M', 'Blue'] },
];

describe('rebuildVariants', () => {
  const SPARSE: VariantInput[] = [
    { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
    { id: 'b', price: '30', available: false, values: ['M', '*'] },
  ];

  it('gives a product that had no options every combination at the price, with fresh ids', () => {
    expect(rebuilt([], [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])], [])).toEqual([
      { id: '1', price: '20', available: true, values: ['S', 'Red'] },
      { id: '2', price: '20', available: true, values: ['S', 'Blue'] },
      { id: '3', price: '20', available: true, values: ['M', 'Red'] },
      { id: '4', price: '20', available: true, values: ['M', 'Blue'] },
    ]);
  });

  it('keeps none for a product with options and no variants (a connector cut them), even on a rename', () => {
    expect(rebuilt([SIZE(['S', 'M'])], [{ ...SIZE(['S', 'M']), name: 'Sizes' }], [])).toEqual([]);
    expect(rebuilt([SIZE(['S', 'M'])], [SIZE(['S', 'M', 'L'])], [])).toEqual([]);
  });

  it('a renamed option changes no variant, a sparse grid and * included', () => {
    const before = [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])];
    const after = [SIZE(['S', 'M']), { ...COLOR(['Red', 'Blue']), name: 'Colour' }];
    expect(rebuilt(before, after, SPARSE)).toEqual(SPARSE);
  });

  it('a new value adds only the combinations no variant stands for yet', () => {
    const before = [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])];
    const after = [SIZE(['S', 'M']), COLOR(['Red', 'Blue', 'Green'])];
    // M/Green is covered by the M/* variant, so only S/Green is new.
    expect(rebuilt(before, after, SPARSE)).toEqual([
      SPARSE[0],
      { id: '1', price: '20', available: true, values: ['S', 'Green'] },
      SPARSE[1],
    ]);
  });

  it('a removed value takes its variants away, and they come back as they were', () => {
    const variants: VariantInput[] = [
      { id: 'tee-s', price: '20', available: true, values: ['S'] },
      { id: 'tee-m', price: '24', available: false, values: ['M'] },
    ];
    const remembered = memory([SIZE(['S', 'M'])], variants);
    const without = rebuilt([SIZE(['S', 'M'])], [SIZE(['S'])], variants, remembered);
    expect(without).toEqual([variants[0]]);
    expect(rebuilt([SIZE(['S'])], [SIZE(['S', 'M'])], without, remembered)).toEqual(variants);
  });

  it('a new option spreads each variant over its values, the first keeping the id', () => {
    const variants: VariantInput[] = [
      { id: 'tee-s', price: '20', available: true, values: ['S'] },
      { id: 'tee-m', price: '24', available: false, values: ['M'] },
    ];
    expect(
      rebuilt([SIZE(['S', 'M'])], [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])], variants),
    ).toEqual([
      { id: 'tee-s', price: '20', available: true, values: ['S', 'Red'] },
      { id: '1', price: '20', available: true, values: ['S', 'Blue'] },
      { id: 'tee-m', price: '24', available: false, values: ['M', 'Red'] },
      { id: '2', price: '24', available: false, values: ['M', 'Blue'] },
    ]);
  });

  it('a removed option merges the variants it told apart, the first of each kept', () => {
    const before = [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])];
    expect(rebuilt(before, [SIZE(['S', 'M'])], GRID)).toEqual([
      { id: 'a', price: '1', available: true, values: ['S'] },
      { id: 'c', price: '3', available: true, values: ['M'] },
    ]);
    expect(rebuilt(before, [COLOR(['Red', 'Blue'])], GRID)).toEqual([
      { id: 'a', price: '1', available: true, values: ['Red'] },
      { id: 'b', price: '2', available: false, values: ['Blue'] },
    ]);
  });

  it('a removed option never leaves a * variant overlapping another', () => {
    const variants: VariantInput[] = [
      { id: 'a', price: '1', available: true, values: ['S', 'Black'] },
      { id: 'b', price: '2', available: true, values: ['XL', '*'] },
    ];
    expect(rebuilt([SIZE(['S', 'XL']), COLOR(['Black'])], [COLOR(['Black'])], variants)).toEqual([
      { id: 'a', price: '1', available: true, values: ['Black'] },
    ]);
  });

  it('an option cleared and typed again (same row) brings every variant back as it was', () => {
    const before = [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])];
    const remembered = memory(before, GRID);
    const merged = rebuilt(before, [SIZE(['S', 'M'])], GRID, remembered);
    expect(rebuilt([SIZE(['S', 'M'])], before, merged, remembered)).toEqual(GRID);
  });

  it('never puts one id on two combinations, even when a remembered one comes back elsewhere', () => {
    const before = [COLOR(['Red', 'Blue']), SIZE(['S', 'M'])];
    const grid: VariantInput[] = [
      { id: 'a', price: '1', available: true, values: ['Red', 'S'] },
      { id: 'b', price: '2', available: true, values: ['Red', 'M'] },
      { id: 'c', price: '3', available: true, values: ['Blue', 'S'] },
      { id: 'd', price: '4', available: true, values: ['Blue', 'M'] },
    ];
    const remembered = memory(before, grid);
    const merged = rebuilt(before, [COLOR(['Red', 'Blue'])], grid, remembered);
    // A new Size row (another key): it spreads the merged variants, no remembered one matches.
    const newSize: KeyedOption = { key: 'size-2', name: 'Size', values: ['M', 'S'] };
    const spread = rebuilt(
      [COLOR(['Red', 'Blue'])],
      [COLOR(['Red', 'Blue']), newSize],
      merged,
      remembered,
    );
    const ids = spread.map((variant) => variant.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(spread).toHaveLength(4);
    // The same row back: the remembered combinations return, and a's id stays on one of them.
    const back = rebuilt([COLOR(['Red', 'Blue'])], before, merged, remembered);
    expect(back).toEqual(grid);
  });

  it('a new option added while another is removed spreads the merged variants by row, never guessing', () => {
    const variants: VariantInput[] = [
      { id: 'a', price: '1', available: true, values: ['S', 'Red'] },
      { id: 'b', price: '2', available: false, values: ['M', 'Red'] },
    ];
    // Same option count, but Color (removed) and Fit (new) are different rows.
    expect(
      rebuilt([SIZE(['S', 'M']), COLOR(['Red'])], [SIZE(['S', 'M']), FIT(['Slim'])], variants),
    ).toEqual([
      { id: 'a', price: '1', available: true, values: ['S', 'Slim'] },
      { id: 'b', price: '2', available: false, values: ['M', 'Slim'] },
    ]);
    // A rename together with a new option: the renamed row keeps its variants.
    const sizes = [SIZE(['S', 'M'])];
    const kept: VariantInput[] = [
      { id: '1', price: '10', available: true, values: ['S'] },
      { id: '2', price: '20', available: false, values: ['M'] },
    ];
    expect(
      rebuilt(sizes, [{ ...SIZE(['S', 'M']), name: 'Shoe size' }, COLOR(['Red'])], kept),
    ).toEqual([
      { id: '1', price: '10', available: true, values: ['S', 'Red'] },
      { id: '2', price: '20', available: false, values: ['M', 'Red'] },
    ]);
  });

  it('never gives a new combination an id any variant of the edit has had', () => {
    const all: VariantInput[] = [
      { id: '1', price: '5', available: true, values: ['S'] },
      { id: '2', price: '5', available: true, values: ['M'] },
      { id: '3', price: '5', available: true, values: ['L'] },
    ];
    const remembered = memory([SIZE(['S', 'M', 'L'])], all);
    const current = all.slice(0, 1);
    expect(
      rebuilt([SIZE(['S'])], [SIZE(['S', 'XL'])], current, remembered).map((variant) => variant.id),
    ).toEqual(['1', '4']);
  });

  it('sorts by option value order, * first', () => {
    const variants: VariantInput[] = [
      { id: 'm', price: '1', available: true, values: ['M'] },
      { id: 'any', price: '1', available: true, values: ['*'] },
    ];
    expect(
      rebuilt([SIZE(['S', 'M'])], [SIZE(['M', 'S'])], variants).map((variant) => variant.id),
    ).toEqual(['any', 'm']);
  });

  it('refuses an option without values and more than 100 variants, takes exactly 100 on every path', () => {
    const none = new Map<string, VariantInput>();
    const fail = rebuildVariants({
      previous: [],
      next: [SIZE([])],
      variants: [],
      remembered: none,
      price: '1',
    });
    expect(fail.ok).toBe(false);
    const values = (count: number) => Array.from({ length: count }, (_value, index) => `v${index}`);
    const fresh = (next: KeyedOption[]) =>
      rebuildVariants({ previous: [], next, variants: [], remembered: none, price: '1' });
    expect(fresh([SIZE(values(100))]).ok).toBe(true);
    expect(fresh([SIZE(values(101))])).toEqual({
      ok: false,
      reason: 'These options make 101 combinations; a product holds at most 100 variants.',
    });
    const sizes = values(10).map((value, index) => ({
      id: String(index + 1),
      price: '1',
      available: true,
      values: [value],
    }));
    const spread = (colors: number) =>
      rebuildVariants({
        previous: [SIZE(values(10))],
        next: [SIZE(values(10)), COLOR(values(colors))],
        variants: sizes,
        remembered: none,
        price: '1',
      });
    const atCap = spread(10);
    expect(atCap.ok && atCap.variants.length).toBe(100);
    expect(spread(11)).toEqual({
      ok: false,
      reason: 'These options make 110 combinations; a product holds at most 100 variants.',
    });
  });

  it('has no variants without options', () => {
    expect(
      rebuilt([SIZE(['S'])], [], [{ id: '1', price: '1', available: true, values: ['S'] }]),
    ).toEqual([]);
  });
});
