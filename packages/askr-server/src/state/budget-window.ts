import type { Queryable } from '../db/db';
import { LIVE_STATUSES, PLAN_SUBSCRIPTIONS_WHERE, SUBSCRIPTION_ORDER } from './plan-subscription';

export const SECS_PER_DAY = 24 * 60 * 60;

const MS_PER_SEC = 1000;
const MONTHS_PER_YEAR = 12;

export function utcDay(now: number): number {
  return Math.floor(now / SECS_PER_DAY);
}

/** The UTC day number the calendar month of `now` starts on. */
export function monthStartDay(now: number): number {
  const date = new Date(now * MS_PER_SEC);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / (SECS_PER_DAY * MS_PER_SEC);
}

/**
 * The span a plan's monthly budget is counted over: spend on UTC days from `startDay` (inclusive)
 * counts, and the budget is whole again at `resetsAt` (Unix seconds).
 */
export interface BudgetWindow {
  startDay: number;
  resetsAt: number;
}

/**
 * `anchor` (Unix seconds) moved by `months` calendar months (any sign), its time of day kept and
 * its day of month clamped to the target month's length, as Stripe bills: Jan 31 + 1 is Feb 28
 * (29 in a leap year), Jan 31 + 2 is Mar 31.
 */
export function addMonths(anchor: number, months: number): number {
  const date = new Date(anchor * MS_PER_SEC);
  const monthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / MONTHS_PER_YEAR);
  const month = ((monthIndex % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), daysInMonth);
  const timeOfDayMs =
    anchor * MS_PER_SEC - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return (Date.UTC(year, month, day) + timeOfDayMs) / MS_PER_SEC;
}

/** The UTC calendar month of `now`: Free, operator-managed and every store without a live plan. */
export function calendarWindow(now: number): BudgetWindow {
  const date = new Date(now * MS_PER_SEC);
  return {
    startDay: monthStartDay(now),
    resetsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / MS_PER_SEC,
  };
}

/**
 * The monthly slice of a subscription billed from `anchor` that holds `now`: from
 * `addMonths(anchor, n)` for the largest integer n of any sign with that `<= now`, to
 * `addMonths(anchor, n + 1)`. Months are always added to the anchor itself (never to the last
 * slice), so a day clamped in a short month comes back the month after.
 */
export function anchoredWindow(anchor: number, now: number): BudgetWindow {
  const anchorDate = new Date(anchor * MS_PER_SEC);
  const nowDate = new Date(now * MS_PER_SEC);
  let months =
    (nowDate.getUTCFullYear() - anchorDate.getUTCFullYear()) * MONTHS_PER_YEAR +
    nowDate.getUTCMonth() -
    anchorDate.getUTCMonth();
  while (addMonths(anchor, months) > now) {
    months -= 1;
  }
  // Defensive: the calendar-month estimate is never short, so this loop does not run today.
  while (addMonths(anchor, months + 1) <= now) {
    months += 1;
  }
  return { startDay: utcDay(addMonths(anchor, months)), resetsAt: addMonths(anchor, months + 1) };
}

/**
 * The window of a store with `anchor` (its plan's subscription `billing_cycle_anchor`, undefined
 * when it has none) at `now`.
 */
export function windowOf(anchor: number | undefined, now: number): BudgetWindow {
  return anchor === undefined ? calendarWindow(now) : anchoredWindow(anchor, now);
}

/**
 * The billing cycle anchor of the subscription that sets a store's plan: only for a store on a
 * plan bought through billing (`plan_source = 'billing'`), the subscription chosen exactly as
 * `reconcilePlan` chooses it. Undefined otherwise, or when that subscription has no anchor stored.
 */
export async function planAnchor(tx: Queryable, owner: string): Promise<number | undefined> {
  const [row] = await tx.query<{ billing_cycle_anchor: number | null }>(
    `select billing_cycle_anchor from billing_subscriptions
     where ${PLAN_SUBSCRIPTIONS_WHERE}
       and exists (select 1 from stores where stores.owner = $1 and stores.plan_source = 'billing')
     ${SUBSCRIPTION_ORDER} limit 1`,
    [owner, LIVE_STATUSES],
  );
  return row?.billing_cycle_anchor ?? undefined;
}

/**
 * The window a store's monthly budget is counted over at `now` (P1, Q1-Q8): a store on a paid
 * plan bought through billing counts from its billing date each month, every other store the UTC
 * calendar month. Run inside the transaction that then reads and reserves against it.
 */
export async function budgetWindow(
  tx: Queryable,
  owner: string,
  now: number,
): Promise<BudgetWindow> {
  return windowOf(await planAnchor(tx, owner), now);
}
