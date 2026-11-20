/**
 * Which store this browser tab is signed in as, so a reload of the tab signs in again with the
 * key this device remembers instead of asking for Continue. It lives in sessionStorage: it holds
 * only the Store ID (never a key), and is cleared on Sign out. Browsers keep sessionStorage for a
 * tab they reopen, restore or duplicate, so such a tab signs in again too. A key that is not
 * remembered on the device cannot be used this way.
 */

const TAB_SESSION_KEY = 'askr-admin-tab-session';

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    // Storage blocked (some privacy settings): the tab simply does not sign in again on a reload.
    return undefined;
  }
}

/** Mark this tab as signed in as `store` (hex). */
export function markTabSignedIn(store: string): void {
  try {
    storage()?.setItem(TAB_SESSION_KEY, store);
  } catch {
    // Full or blocked storage: Continue is still there after a reload.
  }
}

/** The store this tab was signed in as before a reload, if any. */
export function tabSignedInStore(): string | undefined {
  try {
    return storage()?.getItem(TAB_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Sign out of this tab: a reload asks for Continue again. */
export function clearTabSignedIn(): void {
  try {
    storage()?.removeItem(TAB_SESSION_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}
