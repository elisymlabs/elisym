import type { StoreView } from './types';
import { percentOfBps, shareBps } from './usage';

/** From this share of the period's budget (basis points) the admin warns it will run out. */
export const MONTH_WARN_BPS = 8_000;

export type BudgetNotice =
  | { tone: 'error'; text: string }
  | { tone: 'warn'; text: string }
  | undefined;

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
};

/** The first day of the next UTC month, as "December 1". */
export function nextMonthStart(now: number): string {
  const date = new Date(now * 1000);
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return next.toLocaleDateString('en-US', DATE_FORMAT);
}

/**
 * The UTC day the budget is whole again, as "December 1": the server's end of this budget period
 * (`usage.budget.resetsAt`), or the next calendar month for an older server that does not send it.
 */
export function budgetResetDay(view: StoreView, now: number): string {
  const resetsAt = view.usage.budget?.resetsAt;
  if (resetsAt === undefined) {
    return nextMonthStart(now);
  }
  return new Date(resetsAt * 1000).toLocaleDateString('en-US', DATE_FORMAT);
}

/**
 * What to tell the owner about the budget on every tab: the chat is paused (the plan's monthly
 * budget, its only one, is used up, as the server judges it), or it is nearly used up.
 * Nothing for a store that is not active or has no plan.
 */
export function budgetNotice(view: StoreView, now: number): BudgetNotice {
  if (view.status !== 'active' || view.tier === null) {
    return undefined;
  }
  if (view.budgetPaused === 'month') {
    return {
      tone: 'error',
      text: `This period's plan budget is used up: the chat does not answer visitors until ${budgetResetDay(view, now)} (UTC), or until you upgrade your plan.`,
    };
  }
  const bps = shareBps(view.usage.month.spent, view.tier.monthlyBudgetUsd);
  if (bps >= MONTH_WARN_BPS) {
    return {
      tone: 'warn',
      text: `You have used ${percentOfBps(bps)}% of this period's budget. When it runs out, the chat stops answering visitors until ${budgetResetDay(view, now)} (UTC).`,
    };
  }
  return undefined;
}
