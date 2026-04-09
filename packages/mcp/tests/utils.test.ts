import { describe, it, expect } from 'vitest';
import {
  formatSol,
  formatSolNumeric,
  formatSolShort,
  parseSolToLamports,
  validateWithdrawAmount,
  truncateStr,
  checkLen,
} from '../src/utils.js';

describe('formatSol', () => {
  it('formats zero', () => {
    expect(formatSol(0n)).toBe('0.000000000 SOL');
  });

  it('formats whole SOL', () => {
    expect(formatSol(1_000_000_000n)).toBe('1.000000000 SOL');
  });

  it('formats fractional', () => {
    expect(formatSol(1_500_000_000n)).toBe('1.500000000 SOL');
  });

  it('formats small amounts', () => {
    expect(formatSol(1n)).toBe('0.000000001 SOL');
  });

  it('formats large amounts', () => {
    expect(formatSol(100_000_000_000n)).toBe('100.000000000 SOL');
  });
});

describe('formatSolNumeric', () => {
  it('returns number without SOL suffix', () => {
    expect(formatSolNumeric(10_000_000n)).toBe('0.010000000');
  });
});

describe('formatSolShort', () => {
  it('truncates to 4 decimal places', () => {
    expect(formatSolShort(10_000_000n)).toBe('0.0100 SOL');
  });

  it('formats whole SOL', () => {
    expect(formatSolShort(1_000_000_000n)).toBe('1.0000 SOL');
  });
});

describe('parseSolToLamports', () => {
  it('parses whole number', () => {
    expect(parseSolToLamports('1')).toBe(1_000_000_000n);
  });

  it('parses decimal', () => {
    expect(parseSolToLamports('0.5')).toBe(500_000_000n);
  });

  it('parses small decimal', () => {
    expect(parseSolToLamports('0.01')).toBe(10_000_000n);
  });

  it('parses leading dot', () => {
    expect(parseSolToLamports('.5')).toBe(500_000_000n);
  });

  it('parses max precision (9 decimals)', () => {
    expect(parseSolToLamports('0.000000001')).toBe(1n);
  });

  it('rejects empty string', () => {
    expect(() => parseSolToLamports('')).toThrow('amount is empty');
  });

  it('rejects negative', () => {
    expect(() => parseSolToLamports('-1')).toThrow('cannot be negative');
  });

  it('rejects >9 decimal places', () => {
    expect(() => parseSolToLamports('0.0000000001')).toThrow('too many decimal places');
  });

  it('handles whitespace', () => {
    expect(parseSolToLamports('  1  ')).toBe(1_000_000_000n);
  });

  it('roundtrips with formatSolNumeric', () => {
    const lamports = 12_345_678_901n;
    const formatted = formatSolNumeric(lamports);
    expect(parseSolToLamports(formatted)).toBe(lamports);
  });
});

describe('validateWithdrawAmount', () => {
  const balance = 1_000_000_000n; // 1 SOL

  it('parses numeric amount', () => {
    expect(validateWithdrawAmount('0.5', balance)).toBe(500_000_000n);
  });

  it("handles 'all' - withdraws balance minus fee reserve", () => {
    expect(validateWithdrawAmount('all', balance)).toBe(999_995_000n);
  });

  it("handles 'ALL' case-insensitive", () => {
    expect(validateWithdrawAmount('ALL', balance)).toBe(999_995_000n);
  });

  it('rejects zero result', () => {
    expect(() => validateWithdrawAmount('0', balance)).toThrow('Nothing to withdraw');
  });

  it('rejects insufficient balance', () => {
    expect(() => validateWithdrawAmount('2', balance)).toThrow('Insufficient balance');
  });

  it("rejects 'all' when balance is below fee reserve", () => {
    expect(() => validateWithdrawAmount('all', 1000n)).toThrow('Nothing to withdraw');
  });
});

describe('truncateStr', () => {
  it('returns short strings unchanged', () => {
    expect(truncateStr('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis', () => {
    expect(truncateStr('hello world', 5)).toBe('hello...');
  });

  it('handles exact length', () => {
    expect(truncateStr('hello', 5)).toBe('hello');
  });
});

describe('checkLen', () => {
  it('passes for short strings', () => {
    expect(() => checkLen('field', 'hi', 100)).not.toThrow();
  });

  it('throws for strings exceeding max bytes', () => {
    expect(() => checkLen('field', 'x'.repeat(101), 100)).toThrow('field too long');
  });

  it('counts bytes not chars (multibyte)', () => {
    // Each emoji is 4 bytes
    const emoji = '\u{1F600}'; // grinning face
    expect(() => checkLen('field', emoji, 3)).toThrow('field too long');
    expect(() => checkLen('field', emoji, 4)).not.toThrow();
  });
});
