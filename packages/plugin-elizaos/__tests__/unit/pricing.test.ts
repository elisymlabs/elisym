import { describe, it, expect } from 'vitest';
import { formatLamportsAsSol, lamportsToSol, solToLamports } from '../../src/lib/pricing';

describe('pricing', () => {
  it('converts whole SOL amounts without drift', () => {
    expect(solToLamports('1')).toBe(1_000_000_000n);
    expect(solToLamports(0.5)).toBe(500_000_000n);
  });

  it('rounds 1-lamport edge correctly', () => {
    expect(solToLamports('0.000000001')).toBe(1n);
  });

  it('rejects negative and non-finite amounts', () => {
    expect(() => solToLamports('-1')).toThrow();
    expect(() => solToLamports('NaN')).toThrow();
  });

  it('round-trips lamports through SOL formatting', () => {
    const amount = 1_234_567_890n;
    const sol = lamportsToSol(amount);
    expect(sol).toBeCloseTo(1.23456789, 9);
  });

  it('formats SOL without trailing zeros', () => {
    expect(formatLamportsAsSol(1_000_000_000n)).toBe('1');
    expect(formatLamportsAsSol(1_500_000_000n)).toBe('1.5');
    expect(formatLamportsAsSol(1n)).toBe('0.000000001');
  });
});
