import { describe, expect, it } from 'vitest';
import { compactZeros, formatCardPrice, formatDecimal } from '../app/lib/formatPrice';

describe('formatDecimal', () => {
  it('never emits exponential notation for sub-microSOL amounts', () => {
    // decimal.js-light switches to exponential form at exponent <= -7 by
    // default, which compactZeros cannot compress.
    expect(formatDecimal(1, 9)).toBe('0.000000001');
    expect(formatDecimal(10, 9)).toBe('0.00000001');
    expect(formatDecimal(100, 9)).toBe('0.0000001');
  });

  it('keeps ordinary amounts unchanged', () => {
    expect(formatDecimal(1_000_000_000, 9)).toBe('1');
    expect(formatDecimal(5_000_000, 6)).toBe('5');
    expect(formatDecimal(50_000, 6)).toBe('0.05');
  });
});

describe('compactZeros', () => {
  it('compresses leading zeros produced by formatDecimal', () => {
    expect(compactZeros(formatDecimal(1, 9))).toBe('0.0₇1');
    expect(compactZeros(formatDecimal(5200, 9))).toBe('0.0₄52');
  });
});

describe('formatCardPrice', () => {
  it('renders a one-lamport SOL price in compact decimal form', () => {
    expect(formatCardPrice(undefined, 1)).toBe('0.0₇1 SOL');
  });
});
