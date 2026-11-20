import Decimal from 'decimal.js-light';
import type { Tier } from './types';

/** Which budget keeps the chat from answering: today's, or the month's. */
export type BudgetPause = 'day' | 'month';

/**
 * Whether the store's budget is used up, by the test a reservation makes (`PgState.fits`): not
 * even one turn's reservation (`reserveUsd`) fits today's or the month's budget any more. The
 * month wins when both are full: it lasts longer, so it is what the owner must know. Undefined
 * while one more turn fits, or for a store with no tier (it answers nothing anyway).
 */
export function budgetPause(
  usage: { today: { spent: string; reserved: string }; month: { spent: string } },
  tier: Tier | undefined,
  reserveUsd: string,
): BudgetPause | undefined {
  if (tier === undefined) {
    return undefined;
  }
  const reserve = new Decimal(reserveUsd);
  // `month.spent` already counts today's spend; today's open reservations count as well.
  const month = new Decimal(usage.month.spent).plus(usage.today.reserved).plus(reserve);
  if (month.greaterThan(tier.monthlyBudgetUsd)) {
    return 'month';
  }
  const today = new Decimal(usage.today.spent).plus(usage.today.reserved).plus(reserve);
  return today.greaterThan(tier.dailyBudgetUsd) ? 'day' : undefined;
}
