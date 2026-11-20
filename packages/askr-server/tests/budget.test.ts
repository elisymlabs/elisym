import { describe, expect, it } from 'vitest';
import { budgetPause } from '../src/state/budget';
import { TIER } from './fixtures';

/** TIER: $5 a day, $100 a month. */
function usage(todaySpent: string, todayReserved: string, monthSpent: string) {
  return { today: { spent: todaySpent, reserved: todayReserved }, month: { spent: monthSpent } };
}

describe('when a used-up budget pauses the chat', () => {
  it('pauses nothing while one more turn fits', () => {
    expect(budgetPause(usage('0', '0', '0'), TIER, '0.05')).toBeUndefined();
    expect(budgetPause(usage('4.95', '0', '50'), TIER, '0.05')).toBeUndefined();
  });

  it('pauses for the day once one turn no longer fits, reservations counted', () => {
    expect(budgetPause(usage('4.96', '0', '50'), TIER, '0.05')).toBe('day');
    expect(budgetPause(usage('4', '0.96', '50'), TIER, '0.05')).toBe('day');
  });

  it('pauses for the month, which wins when both are used up', () => {
    expect(budgetPause(usage('1', '0', '99.96'), TIER, '0.05')).toBe('month');
    expect(budgetPause(usage('5', '0', '100'), TIER, '0.05')).toBe('month');
  });

  it('with no reserve configured, pauses only past the budget itself', () => {
    expect(budgetPause(usage('5', '0', '50'), TIER, '0')).toBeUndefined();
    expect(budgetPause(usage('5.01', '0', '50'), TIER, '0')).toBe('day');
  });

  it('a store with no tier is not paused by a budget', () => {
    expect(budgetPause(usage('9', '0', '900'), undefined, '0.05')).toBeUndefined();
  });
});
