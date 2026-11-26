/**
 * Which owner this browser tab is signed in as, so a reload of the tab signs in again with the
 * key this device remembers instead of asking for Continue. It lives in sessionStorage: it holds
 * only the owner's public key (never a secret), and is cleared on Sign out. Browsers keep
 * sessionStorage for a tab they reopen, restore or duplicate, so such a tab signs in again too. A
 * key that is not remembered on the device cannot be used this way.
 */

const TAB_SESSION_KEY = 'paycore-hosted.tab-session';

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    // Storage blocked (some privacy settings): the tab simply does not sign in again on a reload.
    return undefined;
  }
}

/** Mark this tab as signed in as `owner` (hex). */
export function markTabSignedIn(owner: string): void {
  try {
    storage()?.setItem(TAB_SESSION_KEY, owner);
  } catch {
    // Full or blocked storage: Continue is still there after a reload.
  }
}

/** The owner this tab was signed in as before a reload, if any. */
export function tabSignedInOwner(): string | undefined {
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
