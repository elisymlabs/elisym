import { PAID_PLANS, cycleOf, planName } from './billing';
import { PLANS } from './plans';
import type { BillingInterval, PaidPlan } from './types';

/** The paid plan and billing period the owner chose on the landing ("Choose Growth", yearly). */
export interface PlanIntent {
  plan: PaidPlan;
  interval: BillingInterval;
}

/** The query parameters the landing's paid links carry (`?plan=growth&interval=year`). */
export const PLAN_PARAM = 'plan';
export const INTERVAL_PARAM = 'interval';

const INTERVALS: readonly BillingInterval[] = ['month', 'year'];

/** Said after the chosen plan before a key exists. */
export const INTENT_SIGN_IN_TEXT = 'Create a key or sign in to continue.';

/** Said when the plan was chosen but this server takes no payments: we set paid plans up. */
export const PAID_THROUGH_US_TEXT = 'Paid plans are set up with us: message us with your Store ID.';

/** The only value of a parameter given exactly once, else undefined. */
function single(values: readonly string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/**
 * The plan the page was opened with, read once at boot: exactly one paid `plan` and exactly one
 * `interval`, else none. Both parameters are removed from the address either way, so a reload
 * does not choose again; everything else in it (the `billing` flag, the hash) stays.
 */
export function takePlanIntent(
  location: Pick<Location, 'href'> | undefined,
  history: Pick<History, 'replaceState' | 'state'> | undefined,
): PlanIntent | undefined {
  if (location === undefined) {
    return undefined;
  }
  const url = new URL(location.href);
  const plans = url.searchParams.getAll(PLAN_PARAM);
  const intervals = url.searchParams.getAll(INTERVAL_PARAM);
  if (plans.length === 0 && intervals.length === 0) {
    return undefined;
  }
  url.searchParams.delete(PLAN_PARAM);
  url.searchParams.delete(INTERVAL_PARAM);
  history?.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const planValue = single(plans);
  const intervalValue = single(intervals);
  const plan = PAID_PLANS.find((paid) => paid === planValue);
  const interval = INTERVALS.find((period) => period === intervalValue);
  return plan === undefined || interval === undefined ? undefined : { plan, interval };
}

/**
 * The chosen plan in one sentence, as its card prices it: "You chose Growth: $79 a month, billed
 * yearly ($948)." or "You chose Growth: $99 a month, billed monthly."
 */
export function intentSummary(intent: PlanIntent): string {
  const name = planName(intent.plan);
  const card = PLANS.find((plan) => plan.name === name);
  if (card === undefined) {
    return `You chose ${name}, billed ${cycleOf(intent.interval)}.`;
  }
  if (intent.interval === 'year') {
    return `You chose ${name}: ${card.yearlyPerMonth ?? card.monthly} a month, billed yearly (${card.yearlyTotal ?? ''}).`;
  }
  return `You chose ${name}: ${card.monthly} a month, billed monthly.`;
}
