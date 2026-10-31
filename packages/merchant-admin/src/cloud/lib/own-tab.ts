/**
 * The console holds the owner key, so it follows the merchant-web origin rules
 * (plan section 3): the key is asked for only in the console's own tab - not
 * framed, and not opened by another page that would keep a handle on it.
 */

/** What the check reads of a window (a `Window` is one). */
export interface TabView {
  opener: unknown;
  top: unknown;
  name: string;
}

export function isOwnTab(view: TabView): boolean {
  return view.opener === null && view.top === view;
}

/** Clears the window's name (how another page would find it again), then says whether it is its own tab. */
export function claimWindow(view: TabView): boolean {
  view.name = '';
  return isOwnTab(view);
}
