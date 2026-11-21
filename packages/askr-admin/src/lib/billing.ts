import type { BillingInterval, BillingView, PaidPlan, ScheduledChange } from './types';

/**
 * Where the admin comes back from Stripe: Checkout paid or left without paying, or a billing
 * portal flow (a plan switch or a cancel) completed.
 */
export type BillingReturn = 'success' | 'canceled' | 'updated';

const BILLING_RETURNS: readonly BillingReturn[] = ['success', 'canceled', 'updated'];

/** The query flag the server's Checkout and portal return URLs carry (`?billing=`). */
export const BILLING_PARAM = 'billing';

/** How often the store is read again after a payment, and for how long at most. */
export const ACTIVATION_POLL_MS = 3_000;
export const ACTIVATION_POLL_LIMIT = 40;

/** Subscription states that keep a paid plan: `past_due` while Stripe retries a payment. */
const LIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

/** The self-serve paid plans, smallest first: a later one is an upgrade. */
export const PAID_PLANS: readonly PaidPlan[] = ['starter', 'growth', 'pro', 'scale'];

/**
 * The `?billing=` flag the page was opened with, removed from the address at once so a reload
 * does not say it again. Anything else in the address stays.
 */
export function takeBillingReturn(
  location: Pick<Location, 'href'> | undefined,
  history: Pick<History, 'replaceState' | 'state'> | undefined,
): BillingReturn | undefined {
  if (location === undefined) {
    return undefined;
  }
  const url = new URL(location.href);
  const value = url.searchParams.get(BILLING_PARAM);
  if (value === null) {
    return undefined;
  }
  url.searchParams.delete(BILLING_PARAM);
  history?.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return BILLING_RETURNS.find((flag) => flag === value);
}

/** A plan's API name from the name the cards show ("Growth" is `growth`). */
export function paidPlanOf(name: string): PaidPlan | undefined {
  const slug = name.toLowerCase();
  return PAID_PLANS.find((plan) => plan === slug);
}

export function isLive(billing: BillingView): boolean {
  return billing.status !== null && LIVE_STATUSES.includes(billing.status);
}

/** A paid plan's name as the cards show it (`growth` is "Growth"). */
export function planName(plan: PaidPlan | null): string {
  return plan === null ? 'paid' : `${plan.slice(0, 1).toUpperCase()}${plan.slice(1)}`;
}

/** A Unix time as a date, in UTC (Stripe's periods are). */
export function dateOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** How a period reads in a sentence: billed monthly or yearly. */
export function cycleOf(interval: BillingInterval | null): string {
  return interval === 'year' ? 'yearly' : 'monthly';
}

/** The change Stripe has scheduled, if the server says one (an older server says nothing). */
export function scheduledChangeOf(billing: BillingView): ScheduledChange | undefined {
  return billing.scheduledChange ?? undefined;
}

/** What Billing says of the store's paid plan; empty when it never had one. */
export function billingLine(billing: BillingView): string {
  if (billing.status === null) {
    return '';
  }
  const plan = planName(billing.plan);
  const end = billing.currentPeriodEnd === null ? undefined : dateOf(billing.currentPeriodEnd);
  if (billing.status === 'past_due') {
    return `A payment for your ${plan} plan failed and is being retried. Your plan stays active meanwhile: update your payment method under Manage billing.`;
  }
  if (isLive(billing) && billing.cancelAtPeriodEnd) {
    return end === undefined
      ? `Your ${plan} plan is canceled and ends with its current period.`
      : `Your ${plan} plan is canceled and ends on ${end}. Your store then moves to Free if it has room, or waits for a new plan; nothing is deleted.`;
  }
  if (isLive(billing)) {
    const cycle = cycleOf(billing.interval);
    const change = scheduledChangeOf(billing);
    if (change !== undefined) {
      const next =
        change.plan === null
          ? 'another plan'
          : `${planName(change.plan)}, billed ${cycleOf(change.interval)},`;
      return `Your ${plan} plan is billed ${cycle} and changes to ${next} on ${dateOf(change.at)}.`;
    }
    return end === undefined
      ? `Your ${plan} plan is billed ${cycle}.`
      : `Your ${plan} plan is billed ${cycle} and renews on ${end}.`;
  }
  if (billing.status === 'incomplete') {
    return `The first payment for your ${plan} plan is not complete yet.`;
  }
  return `Your ${plan} plan ended.`;
}

/** Back from a paid checkout, once the plan is live. */
export const ACTIVE_TEXT = 'Payment received. Your plan is active.';
/** The same, for a store that paid before its settings were saved: the assistant needs them. */
export const ACTIVE_ONBOARDING_TEXT = 'Your plan is active: describe your store to finish.';
/** Back from a portal flow (D8): Stripe's event may come a moment after the page. */
export const UPDATED_TEXT =
  'Your plan change is saved. It can take a minute to show here; refresh the page to see it.';
