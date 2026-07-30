import { useSyncExternalStore } from 'react';

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

/**
 * Whether the document is currently visible. The unseen-clear effects key on
 * this: "the page stays open" must mean "the user can see it", or a background
 * tab parked on /jobs (or an agent's Chat tab) would eat every badge the
 * active tab stamps, via the cross-tab storage event.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, isDocumentVisible);
}
