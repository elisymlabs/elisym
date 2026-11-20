import type { StoreView } from './types';

/**
 * What a pending store's owner is told wherever its status shows (6.4):
 * saving the settings asks the server to activate the store again.
 */
export const PENDING_TEXT =
  'Your store is waiting for activation. Save your settings again to retry, or message us with your Store ID.';

/**
 * For a pending store the server cannot activate on its own: auto-activation
 * off, its plan missing, or a store the operator set back to pending (it keeps
 * its tier, and only the operator activates it again). Saving again would not
 * help, so only the way to us.
 */
export const PENDING_CONTACT_TEXT =
  'Your store is waiting for activation. Message us with your Store ID.';

/** What a pending store shows: a store that had a plan is activated only by us. */
export function pendingTextOf(view: Pick<StoreView, 'tier'>): string {
  return view.tier === null ? PENDING_TEXT : PENDING_CONTACT_TEXT;
}

/** Under the plan of an active store. */
export const UPGRADE_TEXT = 'To move to a larger plan, message us with your Store ID.';
