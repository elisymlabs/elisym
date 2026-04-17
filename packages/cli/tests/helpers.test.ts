import { describe, it, expect } from 'vitest';
import {
  getRpcUrl,
  parseSolToLamports,
  formatLamports,
  validateJobPrice,
  RENT_EXEMPT_MINIMUM,
} from '../src/helpers.js';

describe('getRpcUrl', () => {
  it('returns devnet URL for devnet', () => {
    expect(getRpcUrl('devnet')).toBe('https://api.devnet.solana.com');
  });

  it('returns devnet URL regardless of input (only devnet is supported)', () => {
    expect(getRpcUrl('mainnet')).toBe('https://api.devnet.solana.com');
    expect(getRpcUrl('testnet')).toBe('https://api.devnet.solana.com');
    expect(getRpcUrl('unknown')).toBe('https://api.devnet.solana.com');
  });

  it('honours SOLANA_RPC_URL override', () => {
    const prev = process.env.SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = 'https://custom.rpc';
    try {
      expect(getRpcUrl('devnet')).toBe('https://custom.rpc');
    } finally {
      if (prev === undefined) {
        delete process.env.SOLANA_RPC_URL;
      } else {
        process.env.SOLANA_RPC_URL = prev;
      }
    }
  });
});

describe('formatLamports', () => {
  it('formats zero', () => {
    expect(formatLamports(0)).toBe('0.000000000');
  });

  it('formats 1 SOL', () => {
    expect(formatLamports(1_000_000_000)).toBe('1.000000000');
  });

  it('formats fractional SOL', () => {
    expect(formatLamports(10_000_000)).toBe('0.010000000');
  });

  it('formats large amounts', () => {
    expect(formatLamports(100_000_000_000)).toBe('100.000000000');
  });

  it('does not include SOL suffix', () => {
    expect(formatLamports(1_000_000_000)).not.toContain('SOL');
  });
});

describe('parseSolToLamports', () => {
  it('parses whole number', () => {
    expect(parseSolToLamports('1')).toBe(1_000_000_000);
  });

  it('parses zero', () => {
    expect(parseSolToLamports('0')).toBe(0);
  });

  it('parses decimal', () => {
    expect(parseSolToLamports('0.01')).toBe(10_000_000);
  });

  it('parses full precision', () => {
    expect(parseSolToLamports('1.000000001')).toBe(1_000_000_001);
  });

  it('parses leading dot', () => {
    expect(parseSolToLamports('.5')).toBe(500_000_000);
  });

  it('trims whitespace', () => {
    expect(parseSolToLamports('  1  ')).toBe(1_000_000_000);
  });

  it('returns null for empty string', () => {
    expect(parseSolToLamports('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseSolToLamports('   ')).toBeNull();
  });

  it('returns null for negative', () => {
    expect(parseSolToLamports('-1')).toBeNull();
  });

  it('returns null for too many decimals', () => {
    expect(parseSolToLamports('0.0000000001')).toBeNull();
  });

  it('returns null for non-numeric', () => {
    expect(parseSolToLamports('abc')).toBeNull();
  });

  it('returns null for trailing dot with no decimals', () => {
    expect(parseSolToLamports('1.')).toBeNull();
  });
});

describe('validateJobPrice', () => {
  const FEE_BPS = 300;

  it('accepts zero (free mode)', () => {
    expect(validateJobPrice(0, false, FEE_BPS)).toBeNull();
  });

  it('accepts funded wallet with any price', () => {
    expect(validateJobPrice(1_000_000, true, FEE_BPS)).toBeNull();
  });

  it('rejects unfunded wallet with price below rent-exempt after fee', () => {
    // 900_000 lamports -> 3% fee = 27_000 -> net = 873_000 < RENT_EXEMPT_MINIMUM
    const result = validateJobPrice(900_000, false, FEE_BPS);
    expect(result).toContain('rent-exempt');
  });

  it('accepts unfunded wallet with sufficient price', () => {
    // 1_000_000 lamports -> 3% fee = 30_000 -> net = 970_000 > RENT_EXEMPT_MINIMUM
    expect(validateJobPrice(1_000_000, false, FEE_BPS)).toBeNull();
  });

  it('message includes rent-exempt minimum', () => {
    const result = validateJobPrice(900_000, false, FEE_BPS);
    expect(result).toContain(String(RENT_EXEMPT_MINIMUM));
  });
});
