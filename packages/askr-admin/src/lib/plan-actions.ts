import { PENDING_CONTACT_TEXT } from './activation';
import {
  PAID_PLANS,
  cycleOf,
  dateOf,
  isLive,
  paidPlanOf,
  planName,
  scheduledChangeOf,
} from './billing';
import { PAID_THROUGH_US_TEXT } from './plan-intent';
import type { PlanChoice } from './plans';
import type { BillingInterval, PaidPlan, StoreView } from './types';

/**
 * What the Billing tab may offer, by the store's state (D6.3); the server refuses the same.
 * - `choosing`: pending with no plan: Free at once, a paid plan at checkout when it takes payments.
 * - `free`: active, a paid plan can be bought (on Free, or a plan that ended).
 * - `paying`: a live paid plan with nothing pending: switch, move up or down, or cancel.
 * - `locked`: a live paid plan with a failed payment, a cancel or a change pending: the portal only
 *   (`contact`: and us, for a scheduled change the portal may not undo).
 * - `through-us`: we manage the plan, the store is suspended, or the server takes no payments.
 */
export type BillingMode =
  | { kind: 'choosing'; checkout: boolean }
  | { kind: 'free' }
  | { kind: 'paying'; plan: PaidPlan; interval: BillingInterval }
  | { kind: 'locked'; line: string; contact: boolean }
  | { kind: 'through-us'; text: string };

/** What a plan card offers. */
export type CardAction =
  | { kind: 'start-free' }
  | { kind: 'checkout' }
  | { kind: 'current' }
  | { kind: 'switch'; label: SwitchLabel }
  | { kind: 'cancel' }
  | { kind: 'contact' }
  | { kind: 'none' };

export type SwitchLabel =
  | 'Switch to yearly'
  | 'Switch to monthly'
  | 'Upgrade'
  | 'Upgrade at renewal'
  | 'Downgrade';

export const SUSPENDED_TEXT = 'Your store is suspended. Message us with your Store ID.';
export const OPERATOR_TEXT =
  "We manage your store's plan. Message us with your Store ID to change it.";

/** A billing-on store whose paid plan neither is live nor can be bought now (a first payment open). */
export const UPGRADE_LATER_TEXT =
  'A paid plan cannot be bought here right now. Check Manage billing, or message us with your Store ID.';

/** The plan a store is on: its live paid plan, Free, or none of the cards (an operator tier). */
export function currentPlanOf(
  view: Pick<StoreView, 'tier' | 'billing'>,
): { plan: PaidPlan; interval: BillingInterval | null } | 'free' | undefined {
  const { billing } = view;
  if (isLive(billing) && billing.plan !== null) {
    return { plan: billing.plan, interval: billing.interval };
  }
  return view.tier?.name.toLowerCase() === 'free' ? 'free' : undefined;
}

/**
 * Why a live paid plan cannot change here, in the server's order (D7), or undefined; `contact`
 * for a scheduled change, which the portal may not let the owner undo.
 */
function lockedLine(
  view: Pick<StoreView, 'billing'>,
): { line: string; contact: boolean } | undefined {
  const { billing } = view;
  const end = billing.currentPeriodEnd === null ? undefined : dateOf(billing.currentPeriodEnd);
  if (billing.status === 'past_due') {
    return {
      line: 'A payment failed. Your plan cannot be changed here until it is paid: update your payment method under Manage billing.',
      contact: false,
    };
  }
  if (billing.cancelAtPeriodEnd) {
    const line =
      end === undefined
        ? 'Your plan ends with its current period. Until then it cannot be changed here: undo the cancel under Manage billing.'
        : `Your plan ends on ${end}. Until then it cannot be changed here: undo the cancel under Manage billing.`;
    return { line, contact: false };
  }
  const change = scheduledChangeOf(billing);
  if (change !== undefined) {
    const next =
      change.plan === null
        ? 'Your plan changes'
        : `Your plan changes to ${planName(change.plan)}, billed ${cycleOf(change.interval)},`;
    return {
      line: `${next} on ${dateOf(change.at)}. Until then it cannot be changed here: undo the change under Manage billing if it offers that, otherwise message us with your Store ID.`,
      contact: true,
    };
  }
  return undefined;
}

export function billingModeOf(view: Pick<StoreView, 'status' | 'tier' | 'billing'>): BillingMode {
  const { billing } = view;
  if (view.status === 'suspended') {
    return { kind: 'through-us', text: SUSPENDED_TEXT };
  }
  if (billing.operatorManaged) {
    return { kind: 'through-us', text: OPERATOR_TEXT };
  }
  if (view.status === 'pending' && view.tier !== null) {
    return { kind: 'through-us', text: PENDING_CONTACT_TEXT };
  }
  if (view.status === 'pending') {
    return { kind: 'choosing', checkout: billing.checkoutAvailable };
  }
  const current = currentPlanOf(view);
  if (billing.enabled && current !== undefined && current !== 'free') {
    const locked = lockedLine(view);
    if (locked !== undefined) {
      return { kind: 'locked', ...locked };
    }
    return { kind: 'paying', plan: current.plan, interval: current.interval ?? 'month' };
  }
  if (billing.checkoutAvailable) {
    return { kind: 'free' };
  }
  return { kind: 'through-us', text: billing.enabled ? UPGRADE_LATER_TEXT : PAID_THROUGH_US_TEXT };
}

function rankOf(plan: PaidPlan): number {
  return PAID_PLANS.indexOf(plan);
}

/** What `card` offers under `interval` in `mode`, for a store on `current`. */
export function cardActionOf(
  mode: BillingMode,
  card: PlanChoice,
  interval: BillingInterval,
  current: ReturnType<typeof currentPlanOf>,
): CardAction {
  if (card.start === 'contact') {
    return { kind: 'contact' };
  }
  const slug = card.start === 'admin' ? 'free' : paidPlanOf(card.name);
  if (slug === undefined) {
    return { kind: 'none' };
  }
  if (slug === 'free' && current === 'free') {
    return { kind: 'current' };
  }
  if (
    slug !== 'free' &&
    typeof current === 'object' &&
    current.plan === slug &&
    current.interval === interval
  ) {
    return { kind: 'current' };
  }
  if (mode.kind === 'choosing') {
    if (slug === 'free') {
      return { kind: 'start-free' };
    }
    return mode.checkout ? { kind: 'checkout' } : { kind: 'none' };
  }
  if (mode.kind === 'free') {
    return slug === 'free' ? { kind: 'none' } : { kind: 'checkout' };
  }
  if (mode.kind !== 'paying') {
    return { kind: 'none' };
  }
  if (slug === 'free') {
    return { kind: 'cancel' };
  }
  if (slug === mode.plan) {
    return {
      kind: 'switch',
      label: interval === 'year' ? 'Switch to yearly' : 'Switch to monthly',
    };
  }
  if (rankOf(slug) < rankOf(mode.plan)) {
    return { kind: 'switch', label: 'Downgrade' };
  }
  // Up to a shorter period: the server sends it to the portal's picker, which applies it at renewal.
  const shorter = mode.interval === 'year' && interval === 'month';
  return { kind: 'switch', label: shorter ? 'Upgrade at renewal' : 'Upgrade' };
}

/** The plan in one line, as Status says it; Billing has the rest. */
export function planSummaryOf(view: Pick<StoreView, 'tier' | 'billing'>): string {
  const current = currentPlanOf(view);
  if (current === 'free') {
    return 'Your plan: Free.';
  }
  if (current !== undefined) {
    return `Your plan: ${planName(current.plan)}, billed ${cycleOf(current.interval)}.`;
  }
  return view.tier === null ? 'No plan yet.' : `Your plan: ${view.tier.name}.`;
}
