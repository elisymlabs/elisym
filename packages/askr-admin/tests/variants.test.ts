import { describe, expect, it } from 'vitest';
import {
  type VariantInput,
  listingPriceOf,
  optionValuesOf,
  renamedValue,
  variantLabel,
  variantProblems,
  withMissingCombinations,
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

const SIZE = (values: string[]) => ({ name: 'Size', values });
const COLOR = (values: string[]) => ({ name: 'Color', values });

function counter(start = 1): () => string {
  let next = start;
  return () => {
    const id = String(next);
    next += 1;
    return id;
  };
}

describe('renamedValue', () => {
  it('names the one value changed in place, nothing for an add, a removal or a reorder', () => {
    expect(renamedValue(['S', 'Blak'], ['S', 'Black'])).toEqual({ from: 'Blak', to: 'Black' });
    expect(renamedValue(['S', 'M'], ['S', 'M', 'L'])).toBeUndefined();
    expect(renamedValue(['S', 'M'], ['S'])).toBeUndefined();
    expect(renamedValue(['S', 'M'], ['M', 'S'])).toBeUndefined();
    expect(renamedValue(['S', 'M'], ['S', 'M'])).toBeUndefined();
  });
});

describe('variantLabel', () => {
  it('reads * as Any and a missing value as ?', () => {
    expect(variantLabel(['M', '*', ''])).toBe('M / Any / ?');
  });
});

describe('withMissingCombinations', () => {
  it('adds every combination no variant stands for, counting *, at the price and in stock', () => {
    const variants: VariantInput[] = [
      { id: 'a', price: '20', available: true, values: ['S', 'Red'] },
      { id: 'b', price: '30', available: false, values: ['M', '*'] },
    ];
    expect(
      withMissingCombinations(
        [SIZE(['S', 'M']), COLOR(['Red', 'Blue'])],
        variants,
        '25',
        counter(),
      ),
    ).toEqual({
      ok: true,
      variants: [...variants, { id: '1', price: '25', available: true, values: ['S', 'Blue'] }],
    });
  });

  it('refuses incomplete options, over 100 variants, and a grid too large to walk', () => {
    expect(withMissingCombinations([SIZE([])], [], '1', counter()).ok).toBe(false);
    expect(withMissingCombinations([], [], '1', counter()).ok).toBe(false);
    const values = (count: number) => Array.from({ length: count }, (_value, index) => `v${index}`);
    const atCap = withMissingCombinations([SIZE(values(100))], [], '1', counter());
    expect(atCap.ok && atCap.variants.length).toBe(100);
    expect(withMissingCombinations([SIZE(values(101))], [], '1', counter())).toEqual({
      ok: false,
      reason: 'These options make 101 combinations; a product holds at most 100 variants.',
    });
    const huge = withMissingCombinations(
      [SIZE(values(200)), COLOR(values(200))],
      [],
      '1',
      counter(),
    );
    expect(huge).toEqual({
      ok: false,
      reason: 'These options make 40000 combinations; a product holds at most 100 variants.',
    });
    // Variants already there count towards the cap.
    const existing = values(99).map((value, index) => ({
      id: String(index),
      price: '1',
      available: true,
      values: [value],
    }));
    expect(withMissingCombinations([SIZE(values(101))], existing, '1', counter(500)).ok).toBe(
      false,
    );
  });
});

describe('variantProblems', () => {
  it('names a missing choice, a value the option no longer has, and an overlap', () => {
    const options = [SIZE(['S', 'M']), COLOR(['Red'])];
    expect(
      variantProblems(options, [
        { id: '1', price: '1', available: true, values: ['S', ''] },
        { id: '2', price: '1', available: true, values: ['L', 'Red'] },
        { id: '3', price: '1', available: true, values: ['M', '*'] },
        { id: '4', price: '1', available: true, values: ['M', 'Red'] },
      ]),
    ).toEqual([
      'Variant 1 (S / ?): pick its Color.',
      'Variant L / Red uses L, which Size no longer has: pick another value or remove the variant.',
      'Variants M / Any and M / Red are the same choice for a shopper (Any stands for every value): change one or remove it.',
    ]);
  });

  it('has nothing to say about fine variants, and waits for an incomplete option', () => {
    expect(
      variantProblems(
        [SIZE(['S', 'M'])],
        [
          { id: '1', price: '1', available: true, values: ['S'] },
          { id: '2', price: '1', available: true, values: ['M'] },
        ],
      ),
    ).toEqual([]);
    expect(
      variantProblems(
        [SIZE(['S']), { name: '', values: [] }],
        [{ id: '1', price: '1', available: true, values: ['S', ''] }],
      ),
    ).toEqual([]);
    expect(variantProblems([], [{ id: '1', price: '1', available: true, values: [] }])).toEqual([
      'Variants need an option: add one, or remove the variants.',
    ]);
  });
});
