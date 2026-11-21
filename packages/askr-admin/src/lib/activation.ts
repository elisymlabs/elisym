import type { StoreView } from './types';

/**
 * What a pending store with no plan yet shows where the plans are not on screen (6.5): a store
 * goes live only once its owner chooses a plan, in Billing (Free at once, a paid plan once it is
 * paid for, or through us).
 */
export const PENDING_TEXT = 'Your store has no plan yet. Choose one in Billing to go live.';

/** The same, as Status says it beside its Choose a plan button, which opens Billing. */
export const PENDING_OVERVIEW_TEXT = 'Your store has no plan yet. Choose one to go live.';

/**
 * For a pending store that keeps a tier: the operator set it back to pending,
 * so only we make it live again. Choosing a plan would not apply to it, so
 * only the way to us.
 */
export const PENDING_CONTACT_TEXT =
  "We manage your store's plan. Message us with your Store ID to make it live.";

/**
 * What a pending store shows: one without a plan is told to choose one (in Billing, or with the
 * button beside the text on the Overview page); one with a plan is managed by us.
 */
export function pendingTextOf(view: Pick<StoreView, 'tier'>, place?: 'overview'): string {
  if (view.tier !== null) {
    return PENDING_CONTACT_TEXT;
  }
  return place === 'overview' ? PENDING_OVERVIEW_TEXT : PENDING_TEXT;
}

/** How to move up from a limit: the Billing tab shows the way for this store (checkout, Manage billing, or us). */
export const UPGRADE_TEXT = 'To move to a larger plan, open Billing.';
