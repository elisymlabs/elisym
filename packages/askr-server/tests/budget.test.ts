import Decimal from 'decimal.js-light';
import { describe, expect, it } from 'vitest';
import {
  MIN_TURN_CEILING_USD,
  budgetReached,
  reserveWarning,
  turnCeiling,
  turnReservation,
} from '../src/state/budget';
import { TIER } from './fixtures';

/** TIER: $100 a month, its only budget. */
function usage(todayReserved: string, monthSpent: string) {
  return { today: { reserved: todayReserved }, month: { spent: monthSpent } };
}

describe('when the plan budget pauses the chat', () => {
  it('pauses nothing while something of the month is left, however little', () => {
    expect(budgetReached(usage('0', '0'), TIER)).toBe(false);
    expect(budgetReached(usage('0', '99.999999999'), TIER)).toBe(false);
  });

  it('pauses once the month is used up, reservations of turns in flight counted', () => {
    expect(budgetReached(usage('0', '100'), TIER)).toBe(true);
    expect(budgetReached(usage('0.25', '99.75'), TIER)).toBe(true);
    expect(budgetReached(usage('0', '100.01'), TIER)).toBe(true);
  });

  it('a store with no tier is not paused by a budget', () => {
    expect(budgetReached(usage('0', '900'), undefined)).toBe(false);
  });
});

describe('a turn reservation clipped to what is left of the month', () => {
  it('reserves the full turn while the month has at least that left', () => {
    expect(turnReservation('0.25', new Decimal('1'))?.toString()).toBe('0.25');
    expect(turnReservation('0.25', new Decimal('0.25'))?.toString()).toBe('0.25');
  });

  it('reserves only what is left below a turn, so a budget can be spent in full', () => {
    expect(turnReservation('0.25', new Decimal('0.05'))?.toString()).toBe('0.05');
    expect(turnReservation('0.25', new Decimal('0.000000001'))?.toFixed()).toBe('0.000000001');
  });

  it('refuses when nothing is left, or the budget was passed', () => {
    expect(turnReservation('0.25', new Decimal('0'))).toBeUndefined();
    expect(turnReservation('0.25', new Decimal('-0.001'))).toBeUndefined();
  });
});

describe("a turn's spend ceiling", () => {
  it('is the reservation when it is a full one or above the floor', () => {
    expect(turnCeiling('0.25', '0.25')).toBe('0.25');
    expect(turnCeiling('0.05', '0.25')).toBe('0.05');
  });

  it('is at least the floor for a clipped reservation, so a normal turn still finishes', () => {
    expect(MIN_TURN_CEILING_USD).toBe('0.01');
    expect(turnCeiling('0.000000001', '0.25')).toBe('0.01');
    expect(turnCeiling('0.002', '0.25')).toBe('0.01');
  });

  it('is never more than a full turn reservation below the floor', () => {
    expect(turnCeiling('0.001', '0.005')).toBe('0.005');
  });
});

describe('the warning for a tier below one turn reservation', () => {
  it('names the tier and the numbers when its monthly budget is below the reservation', () => {
    expect(reserveWarning({ ...TIER, name: 'free', monthlyBudgetUsd: '0.050000000' }, '0.25')).toBe(
      "tier free: its monthly budget 0.05 USD is below one turn's reservation (ASKR_TURN_RESERVE_USD 0.25): its turns reserve only what is left, so one turn in flight can hold the whole budget and the store answers about one visitor at a time. Raise the tier's monthly budget, or lower ASKR_TURN_RESERVE_USD (and ASKR_MAX_TOKENS so a turn still fits it).",
    );
  });

  it('says nothing at or above the reservation', () => {
    expect(reserveWarning({ ...TIER, monthlyBudgetUsd: '0.25' }, '0.25')).toBeUndefined();
    expect(reserveWarning(TIER, '0.25')).toBeUndefined();
  });
});
