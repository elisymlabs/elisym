import { describe, it, expect } from 'vitest';
import { HOUR_MS } from '../../src/constants';
import {
  createSpendingBucket,
  assertCanSpend,
  requiresApproval,
  recordSpend,
  hourlyTotal,
  SpendingLimitError,
} from '../../src/lib/spendingGuard';

function bucket() {
  return createSpendingBucket({
    maxSpendPerJobLamports: 20_000_000n,
    maxSpendPerHourLamports: 50_000_000n,
    requireApprovalAboveLamports: 5_000_000n,
  });
}

describe('spendingGuard', () => {
  it('rejects non-positive amounts', () => {
    expect(() => assertCanSpend(bucket(), 0n)).toThrow(SpendingLimitError);
    expect(() => assertCanSpend(bucket(), -1n)).toThrow(SpendingLimitError);
  });

  it('rejects amounts above per-job cap', () => {
    expect(() => assertCanSpend(bucket(), 20_000_001n)).toThrow(/per-job cap/);
  });

  it('accepts amounts within per-job cap', () => {
    expect(() => assertCanSpend(bucket(), 20_000_000n)).not.toThrow();
  });

  it('tracks hourly total and rejects overflow', () => {
    const b = bucket();
    recordSpend(b, 15_000_000n);
    recordSpend(b, 15_000_000n);
    recordSpend(b, 15_000_000n);
    expect(hourlyTotal(b)).toBe(45_000_000n);
    expect(() => assertCanSpend(b, 10_000_000n)).toThrow(/hourly cap/);
  });

  it('prunes events older than one hour', () => {
    const b = bucket();
    const stale = Date.now() - HOUR_MS - 1;
    recordSpend(b, 45_000_000n, stale);
    expect(hourlyTotal(b)).toBe(0n);
    expect(() => assertCanSpend(b, 20_000_000n)).not.toThrow();
  });

  it('flags amounts above approval threshold', () => {
    const b = bucket();
    expect(requiresApproval(b, 5_000_000n)).toBe(false);
    expect(requiresApproval(b, 5_000_001n)).toBe(true);
  });
});
