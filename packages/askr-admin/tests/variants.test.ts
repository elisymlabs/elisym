import { describe, expect, it } from 'vitest';
import { listingPriceOf, optionValuesOf, variantsFromOptions } from '../src/lib/variants';

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
  });
});

describe('variantsFromOptions', () => {
  it('makes every combination in option order with the given price and fresh ids', () => {
    const result = variantsFromOptions(
      [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Color', values: ['Red', 'Blue'] },
      ],
      [],
      '20',
    );
    expect(result).toEqual({
      ok: true,
      variants: [
        { id: '1', price: '20', available: true, values: ['S', 'Red'] },
        { id: '2', price: '20', available: true, values: ['S', 'Blue'] },
        { id: '3', price: '20', available: true, values: ['M', 'Red'] },
        { id: '4', price: '20', available: true, values: ['M', 'Blue'] },
      ],
    });
  });

  it('keeps a remaining combination whole and never reuses a kept id', () => {
    const existing = [
      { id: '2', price: '25', available: false, values: ['M'] },
      { id: 'old', price: '21', available: true, values: ['XL'] },
    ];
    const result = variantsFromOptions([{ name: 'Size', values: ['S', 'M', 'L'] }], existing, '20');
    expect(result).toEqual({
      ok: true,
      variants: [
        { id: '1', price: '20', available: true, values: ['S'] },
        { id: '2', price: '25', available: false, values: ['M'] },
        { id: '3', price: '20', available: true, values: ['L'] },
      ],
    });
  });

  it('has no variants without options, and refuses an empty option or too many combinations', () => {
    expect(
      variantsFromOptions([], [{ id: '1', price: '1', available: true, values: [] }], '1'),
    ).toEqual({
      ok: true,
      variants: [],
    });
    expect(variantsFromOptions([{ name: 'Size', values: [] }], [], '1').ok).toBe(false);
    const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const atCap = variantsFromOptions(
      [
        { name: 'A', values: ten },
        { name: 'B', values: ten },
      ],
      [],
      '1',
    );
    expect(atCap.ok && atCap.variants.length).toBe(100);
    const over = variantsFromOptions(
      [
        { name: 'A', values: ten },
        { name: 'B', values: ten },
        { name: 'C', values: ['x', 'y'] },
      ],
      [],
      '1',
    );
    expect(over).toEqual({
      ok: false,
      reason: 'These options make 200 combinations; a product holds at most 100 variants.',
    });
  });

  it('takes exactly 100 combinations, not 101, and never gives out a retired id', () => {
    const hundredOne = Array.from({ length: 101 }, (_value, index) => `v${index}`);
    expect(variantsFromOptions([{ name: 'A', values: hundredOne }], [], '1').ok).toBe(false);
    expect(variantsFromOptions([{ name: 'A', values: hundredOne.slice(0, 100) }], [], '1').ok).toBe(
      true,
    );
    const result = variantsFromOptions(
      [{ name: 'Size', values: ['S', 'XL'] }],
      [{ id: '1', price: '5', available: true, values: ['S'] }],
      '5',
      new Set(['2', '3']),
    );
    expect(result.ok && result.variants.map((variant) => variant.id)).toEqual(['1', '4']);
  });
});
