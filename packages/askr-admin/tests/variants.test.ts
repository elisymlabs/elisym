import { describe, expect, it } from 'vitest';
import {
  type OptionInput,
  type VariantInput,
  listingPriceOf,
  optionValuesOf,
  rebuildVariants,
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

const SIZE = (values: string[]): OptionInput => ({ name: 'Size', values });
const COLOR = (values: string[]): OptionInput => ({ name: 'Color', values });

function rebuilt(
  previous: OptionInput[],
  next: OptionInput[],
  variants: VariantInput[],
  remembered: VariantInput[] = variants,
): VariantInput[] {
  const result = rebuildVariants({ previous, next, variants, remembered, price: '20' });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.variants;
}

describe('rebuildVariants', () => {
  const SPARSE: VariantInput[] = [
    { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
    { id: 'b', price: '30', available: false, values: ['M', '*'] },
  ];

  it('gives a product with no variants every combination at the price, with fresh ids', () => {
    expect(rebuilt([], [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])], [])).toEqual([
      { id: '1', price: '20', available: true, values: ['S', 'Red'] },
      { id: '2', price: '20', available: true, values: ['S', 'Blue'] },
      { id: '3', price: '20', available: true, values: ['M', 'Red'] },
      { id: '4', price: '20', available: true, values: ['M', 'Blue'] },
    ]);
  });

  it('a renamed option changes no variant, a sparse grid and * included', () => {
    const before = [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])];
    const after = [SIZE(['S', 'M']), { name: 'Colour', values: ['Red', 'Blue'] }];
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
    const before = [SIZE(['S', 'M'])];
    const variants: VariantInput[] = [
      { id: 'tee-s', price: '20', available: true, values: ['S'] },
      { id: 'tee-m', price: '24', available: false, values: ['M'] },
    ];
    const without = rebuilt(before, [SIZE(['S'])], variants);
    expect(without).toEqual([variants[0]]);
    expect(rebuilt([SIZE(['S'])], before, without, variants)).toEqual(variants);
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
    const variants: VariantInput[] = [
      { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
      { id: 'b', price: '22', available: true, values: ['S', 'Blue'] },
      { id: 'c', price: '24', available: true, values: ['M', 'Red'] },
    ];
    expect(
      rebuilt([SIZE(['S', 'M']), COLOR(['Red', 'Blue'])], [SIZE(['S', 'M'])], variants),
    ).toEqual([
      { id: 'a', price: '20', available: true, values: ['S'] },
      { id: 'c', price: '24', available: true, values: ['M'] },
    ]);
    expect(
      rebuilt([SIZE(['S', 'M']), COLOR(['Red', 'Blue'])], [COLOR(['Red', 'Blue'])], variants),
    ).toEqual([
      { id: 'a', price: '20', available: true, values: ['Red'] },
      { id: 'b', price: '22', available: true, values: ['Blue'] },
    ]);
  });

  it('never gives a new combination an id any variant of the edit has had', () => {
    const remembered: VariantInput[] = [
      { id: '1', price: '5', available: true, values: ['S'] },
      { id: '2', price: '5', available: true, values: ['M'] },
      { id: '3', price: '5', available: true, values: ['L'] },
    ];
    const variants = [remembered[0]].filter((variant) => variant !== undefined);
    expect(
      rebuilt([SIZE(['S'])], [SIZE(['S', 'XL'])], variants, remembered).map(
        (variant) => variant.id,
      ),
    ).toEqual(['1', '4']);
  });

  it('refuses an option without values and more than 100 variants, takes exactly 100', () => {
    const fail = rebuildVariants({
      previous: [],
      next: [SIZE([])],
      variants: [],
      remembered: [],
      price: '1',
    });
    expect(fail.ok).toBe(false);
    const values = (count: number) => Array.from({ length: count }, (_value, index) => `v${index}`);
    const make = (next: OptionInput[]) =>
      rebuildVariants({ previous: [], next, variants: [], remembered: [], price: '1' });
    expect(make([SIZE(values(100))]).ok).toBe(true);
    expect(make([SIZE(values(101))])).toEqual({
      ok: false,
      reason: 'These options make 101 combinations; a product holds at most 100 variants.',
    });
    const grown = rebuildVariants({
      previous: [SIZE(values(10))],
      next: [SIZE(values(10)), COLOR(values(11))],
      variants: values(10).map((value, index) => ({
        id: String(index + 1),
        price: '1',
        available: true,
        values: [value],
      })),
      remembered: [],
      price: '1',
    });
    expect(grown).toEqual({
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
