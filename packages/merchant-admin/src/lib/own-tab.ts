/**
 * Whether the admin runs in its own tab: not framed, and not opened by another
 * page, which would hold a handle on this one. Only then is the key asked for.
 */
export function isOwnTab(view: Window): boolean {
  return view.opener === null && view.top === view;
}

/** Clear the window's name (how another page would find it again), then say whether it is its own tab. */
export function claimWindow(view: Window): boolean {
  view.name = '';
  return isOwnTab(view);
}
