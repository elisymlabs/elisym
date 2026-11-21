import { describe, expect, it } from 'vitest';
import {
  type VariantInput,
  optionValuesOf,
  renamedValue,
  variantLabel,
  variantProblems,
  withMissingCombinations,
} from '../src/lib/variants';

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
    expect(withMissingCombinations([{ name: '', values: ['S'] }], [], '1', counter()).ok).toBe(
      false,
    );
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
  it('names a missing choice, a value the option no longer has, a bad price and an overlap', () => {
    const options = [SIZE(['S', 'M']), COLOR(['Red'])];
    expect(
      variantProblems(options, [
        { id: '1', price: '1', available: true, values: ['S', ''] },
        { id: '2', price: '1', available: true, values: ['L', 'Red'] },
        { id: '3', price: '1.', available: true, values: ['M', 'Red'] },
        { id: '4', price: '1', available: true, values: ['M', '*'] },
      ]),
    ).toEqual([
      'Variant 3 (M / Red): the price is not a number like 19.90.',
      'Variant 1 (S / ?): pick its Color.',
      'Variant 2 (L / Red) uses L, which Size no longer has: pick another value or remove the variant.',
      'Variant 3 (M / Red) and Variant 4 (M / Any) are the same choice for a shopper (Any stands for every value): change one or remove it.',
    ]);
  });

  it('names each overlapping pair once, with numbers, and skips a variant not picked yet', () => {
    const options = [SIZE(['S', 'M'])];
    const three = ['1', '2', '3'].map((id) => ({ id, price: '1', available: true, values: ['S'] }));
    expect(variantProblems(options, three)).toEqual([
      'Variant 1 (S) and Variant 2 (S) are the same choice for a shopper (Any stands for every value): change one or remove it.',
      'Variant 1 (S) and Variant 3 (S) are the same choice for a shopper (Any stands for every value): change one or remove it.',
      'Variant 2 (S) and Variant 3 (S) are the same choice for a shopper (Any stands for every value): change one or remove it.',
    ]);
    expect(
      variantProblems(options, [
        { id: '1', price: '1', available: true, values: ['S'] },
        { id: '2', price: '1', available: true, values: [''] },
      ]),
    ).toEqual(['Variant 2 (?): pick its Size.']);
    expect(
      variantProblems(options, [
        { id: '1', price: '1', available: true, values: [''] },
        { id: '2', price: '1', available: true, values: [''] },
      ]),
    ).toEqual(['Variant 1 (?): pick its Size.', 'Variant 2 (?): pick its Size.']);
  });

  it('leaves overlaps the product came with, and refuses one an edit made', () => {
    const options = [SIZE(['S', 'M'])];
    const initial: VariantInput[] = [
      { id: '11', price: '1', available: true, values: ['*'] },
      { id: '12', price: '1', available: true, values: ['S'] },
    ];
    expect(variantProblems(options, initial, initial)).toEqual([]);
    // The pair is told by id: renamed values keep the exemption, a new variant does not get it.
    const renamed = [initial[0], { id: '12', price: '1', available: true, values: ['M'] }].filter(
      (variant) => variant !== undefined,
    );
    expect(variantProblems(options, renamed, initial)).toEqual([]);
    const added = [...initial, { id: '13', price: '1', available: true, values: ['M'] }];
    expect(variantProblems(options, added, initial)).toEqual([
      'Variant 1 (Any) and Variant 3 (M) are the same choice for a shopper (Any stands for every value): change one or remove it.',
    ]);
  });

  it('has nothing to say about fine variants, waits for an incomplete option, takes one option-less variant', () => {
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
    expect(variantProblems([], [{ id: '1', price: '1', available: true, values: [] }])).toEqual([]);
    expect(
      variantProblems(
        [],
        [
          { id: '1', price: '1', available: true, values: [] },
          { id: '2', price: '2', available: true, values: [] },
        ],
      ),
    ).toEqual(['Several variants need an option to tell them apart: add one, or remove variants.']);
  });
});
