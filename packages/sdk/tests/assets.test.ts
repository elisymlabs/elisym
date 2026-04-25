import { describe, it, expect } from 'vitest';
import {
  NATIVE_SOL,
  KNOWN_ASSETS,
  assetKey,
  assetByKey,
  resolveKnownAsset,
  parseAssetAmount,
  formatAssetAmount,
  type Asset,
} from '../src/payment/assets';

const SPL_FIXTURE: Asset = {
  chain: 'solana',
  token: 'usdc',
  mint: 'TestMint1111111111111111111111111111111111',
  decimals: 6,
  symbol: 'USDC',
};

describe('assetKey', () => {
  it('uses two-part form for native assets', () => {
    expect(assetKey(NATIVE_SOL)).toBe('solana:sol');
  });

  it('uses three-part form for SPL/ERC-20', () => {
    expect(assetKey(SPL_FIXTURE)).toBe('solana:usdc:TestMint1111111111111111111111111111111111');
  });
});

describe('resolveKnownAsset / assetByKey', () => {
  it('resolves known native SOL', () => {
    expect(resolveKnownAsset('solana', 'sol')).toBe(NATIVE_SOL);
    expect(assetByKey('solana:sol')).toBe(NATIVE_SOL);
  });

  it('returns undefined for unknown combinations', () => {
    expect(resolveKnownAsset('solana', 'btc')).toBeUndefined();
    expect(resolveKnownAsset('ethereum', 'eth')).toBeUndefined();
    expect(assetByKey('nope:nope')).toBeUndefined();
  });

  it('KNOWN_ASSETS exposes SOL and USDC (devnet)', () => {
    expect(KNOWN_ASSETS).toHaveLength(2);
    expect(KNOWN_ASSETS[0]).toBe(NATIVE_SOL);
    expect(KNOWN_ASSETS[1]?.token).toBe('usdc');
    expect(KNOWN_ASSETS[1]?.mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });
});

describe('parseAssetAmount', () => {
  it('parses SOL whole numbers', () => {
    expect(parseAssetAmount(NATIVE_SOL, '1')).toBe(1_000_000_000n);
    expect(parseAssetAmount(NATIVE_SOL, '10')).toBe(10_000_000_000n);
  });

  it('parses SOL decimals', () => {
    expect(parseAssetAmount(NATIVE_SOL, '0.5')).toBe(500_000_000n);
    expect(parseAssetAmount(NATIVE_SOL, '0.1')).toBe(100_000_000n);
    expect(parseAssetAmount(NATIVE_SOL, '0.000000001')).toBe(1n);
  });

  it('parses SPL (6 decimals) amounts', () => {
    expect(parseAssetAmount(SPL_FIXTURE, '1')).toBe(1_000_000n);
    expect(parseAssetAmount(SPL_FIXTURE, '1.234567')).toBe(1_234_567n);
    expect(parseAssetAmount(SPL_FIXTURE, '0.000001')).toBe(1n);
  });

  it('rejects overspecified fractions', () => {
    expect(() => parseAssetAmount(NATIVE_SOL, '1.1234567890')).toThrow(/too many decimals/);
    expect(() => parseAssetAmount(SPL_FIXTURE, '1.1234567')).toThrow(/too many decimals/);
  });

  it('rejects malformed strings', () => {
    expect(() => parseAssetAmount(NATIVE_SOL, '')).toThrow();
    expect(() => parseAssetAmount(NATIVE_SOL, '-1')).toThrow(/cannot be negative/);
    expect(() => parseAssetAmount(NATIVE_SOL, '1e9')).toThrow(/decimal/);
    expect(() => parseAssetAmount(NATIVE_SOL, '1,000')).toThrow(/decimal/);
    expect(() => parseAssetAmount(NATIVE_SOL, 'abc')).toThrow(/decimal/);
  });

  it('rejects zero', () => {
    expect(() => parseAssetAmount(NATIVE_SOL, '0')).toThrow(/positive/);
    expect(() => parseAssetAmount(NATIVE_SOL, '0.0')).toThrow(/positive/);
  });
});

describe('formatAssetAmount', () => {
  it('formats SOL trimming trailing zeros', () => {
    expect(formatAssetAmount(NATIVE_SOL, 0n)).toBe('0 SOL');
    expect(formatAssetAmount(NATIVE_SOL, 1n)).toBe('0.000000001 SOL');
    expect(formatAssetAmount(NATIVE_SOL, 100_000_000n)).toBe('0.1 SOL');
    expect(formatAssetAmount(NATIVE_SOL, 1_000_000_000n)).toBe('1 SOL');
  });

  it('formats SPL trimming trailing zeros', () => {
    expect(formatAssetAmount(SPL_FIXTURE, 1_234_567n)).toBe('1.234567 USDC');
    expect(formatAssetAmount(SPL_FIXTURE, 1_000_000n)).toBe('1 USDC');
    expect(formatAssetAmount(SPL_FIXTURE, 10_000n)).toBe('0.01 USDC');
  });

  it('formats negative amounts', () => {
    expect(formatAssetAmount(SPL_FIXTURE, -10_000n)).toBe('-0.01 USDC');
  });

  it('roundtrips parse → format → parse', () => {
    const raw = parseAssetAmount(NATIVE_SOL, '0.5');
    const formatted = formatAssetAmount(NATIVE_SOL, raw);
    expect(formatted).toBe('0.5 SOL');
    expect(parseAssetAmount(NATIVE_SOL, '0.5')).toBe(raw);
  });
});
