import { describe, expect, it } from 'vitest';
import {
  compactZeros,
  formatCardPrice,
  formatCardPriceLabel,
  formatDecimal,
  plausibleReportedPrice,
  settledPriceForEntry,
} from '../app/lib/formatPrice';

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

describe('formatCardPriceLabel', () => {
  const usdc = {
    chain: 'solana' as const,
    network: 'devnet' as const,
    address: 'a',
    token: 'usdc' as const,
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    decimals: 6,
    symbol: 'USDC',
  };
  const flat = { payment: { ...usdc, job_price: 23_000 } } as never;
  const metered = {
    payment: { ...usdc, job_price: 23_000 },
    metered: { min_subunits: '1000' },
  } as never;

  it('renders a flat card as a single price', () => {
    expect(formatCardPriceLabel(flat)).toBe('0.023 USDC');
  });

  it('renders a metered card as a range when the range is reachable', () => {
    // A flat "0.023 USDC" would overstate the usual cost several-fold; that is
    // the whole reason metering exists.
    expect(formatCardPriceLabel(metered, { allowRange: true })).toBe('0.001 USDC - 0.023 USDC');
  });

  it('defaults to the flat ceiling when the flag is omitted', () => {
    // Only the delegated rail meters, so an omitted flag must not advertise a
    // floor the buyer may have no way to reach - that is the same under-display
    // failure metering exists to avoid, pointed the other way. This is also
    // what the browse-level product card relies on.
    expect(formatCardPriceLabel(metered)).toBe('0.023 USDC');
    expect(formatCardPriceLabel(metered, { allowRange: false })).toBe('0.023 USDC');
  });

  it('collapses a degenerate range - a floor equal to the ceiling is a flat price', () => {
    // The card parser keeps `min === price` deliberately, so this is reachable
    // and operator-configurable. "0.023 USDC - 0.023 USDC" reads like a bug.
    const degenerate = {
      payment: { ...usdc, job_price: 23_000 },
      metered: { min_subunits: '23000' },
    } as never;
    expect(formatCardPriceLabel(degenerate, { allowRange: true })).toBe('0.023 USDC');
  });

  it('returns null for a free or price-less card', () => {
    expect(formatCardPriceLabel({ payment: { ...usdc, job_price: 0 } } as never)).toBeNull();
    expect(formatCardPriceLabel({ payment: { ...usdc } } as never)).toBeNull();
    expect(formatCardPriceLabel({} as never)).toBeNull();
  });
});

describe('settledPriceForEntry', () => {
  const usdc = {
    chain: 'solana' as const,
    network: 'devnet' as const,
    address: 'a',
    token: 'usdc' as const,
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    decimals: 6,
    symbol: 'USDC',
  };
  const metered = {
    payment: { ...usdc, job_price: 23_000 },
    metered: { min_subunits: '1000' },
  } as never;
  const flat = { payment: { ...usdc, job_price: 23_000 } } as never;

  it('accepts a delegated figure inside the published range', () => {
    expect(settledPriceForEntry(metered, { delegated: true, reported: 6_100 })).toBe(6_100);
  });

  it('REFUSES an ordinary-rail figure - that tag is the net, not what was sent', () => {
    // The buyer signed the ceiling; the provider's tag is price minus protocol
    // fee, which lands inside the window and would record less than the wallet
    // actually spent on every honest per-job purchase.
    expect(settledPriceForEntry(metered, { delegated: false, reported: 6_100 })).toBeNull();
  });

  it('refuses anything on a card that is not metered', () => {
    expect(settledPriceForEntry(flat, { delegated: true, reported: 6_100 })).toBeNull();
  });

  it('refuses a figure outside the published range, either side', () => {
    expect(settledPriceForEntry(metered, { delegated: true, reported: 999 })).toBeNull();
    expect(settledPriceForEntry(metered, { delegated: true, reported: 23_001 })).toBeNull();
  });

  it('refuses a missing or non-integer figure', () => {
    expect(settledPriceForEntry(metered, { delegated: true, reported: undefined })).toBeNull();
    expect(settledPriceForEntry(metered, { delegated: true, reported: 6_100.5 })).toBeNull();
  });
});

describe('plausibleReportedPrice', () => {
  it('keeps a positive integer', () => {
    expect(plausibleReportedPrice(6_100)).toBe(6_100);
  });

  it('refuses zero - the chat entry renders that as "Free"', () => {
    // A provider tagging `amount 0` would otherwise make a paid job read as free.
    expect(plausibleReportedPrice(0)).toBeNull();
  });

  it('refuses negative, non-integer and absent values', () => {
    expect(plausibleReportedPrice(-5)).toBeNull();
    expect(plausibleReportedPrice(1.5)).toBeNull();
    expect(plausibleReportedPrice(Number.NaN)).toBeNull();
    expect(plausibleReportedPrice(undefined)).toBeNull();
  });
});
