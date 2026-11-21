import type { StoreView } from './types';

/**
 * What a pending store with no plan yet shows where the plan picker is not on
 * screen (6.5): a store goes live only once its owner chooses a plan, in
 * Overview (Free at once, a paid plan through us).
 */
export const PENDING_TEXT = 'Your store has no plan yet. Choose one in Overview to go live.';

/** The same, in Overview, right above the plan picker. */
export const PENDING_OVERVIEW_TEXT = 'Your store has no plan yet. Choose one below to go live.';

/**
 * For a pending store that keeps a tier: the operator set it back to pending,
 * so only we make it live again. Choosing a plan would not apply to it, so
 * only the way to us.
 */
export const PENDING_CONTACT_TEXT =
  "We manage your store's plan. Message us with your Store ID to make it live.";

/**
 * What a pending store shows: one without a plan is told to choose one (in
 * Overview, or below when Overview shows the picker); one with a plan is
 * managed by us.
 */
export function pendingTextOf(view: Pick<StoreView, 'tier'>, place?: 'overview'): string {
  if (view.tier !== null) {
    return PENDING_CONTACT_TEXT;
  }
  return place === 'overview' ? PENDING_OVERVIEW_TEXT : PENDING_TEXT;
}

/** Under the plan of an active store we bill by hand, or while the server takes no payments. */
export const UPGRADE_TEXT = 'To move to a larger plan, message us with your Store ID.';

/** Under the plan of an active store on Free, when the server takes payments. */
export const UPGRADE_SELF_TEXT =
  'Move to a paid plan: it starts as soon as the payment goes through.';

/** Under the plan of a store with a paid subscription. */
export const MANAGE_TEXT =
  'To change or cancel your plan, use Manage billing under Status. For Enterprise, message us with your Store ID.';
