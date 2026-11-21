import { describe, expect, it } from 'vitest';
import { listingPriceOf } from '../src/variants';

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
