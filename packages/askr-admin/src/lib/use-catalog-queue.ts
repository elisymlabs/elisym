import { useCallback, useSyncExternalStore } from 'react';
import type { CatalogQueue, QueueEntry } from './catalog-writer';

const NO_ENTRIES: readonly QueueEntry[] = [];

/** The queue's entries, rendering again on every change; none without a queue. */
export function useQueueEntries(queue: CatalogQueue | undefined): readonly QueueEntry[] {
  const subscribe = useCallback(
    (listener: () => void) => queue?.subscribe(listener) ?? (() => undefined),
    [queue],
  );
  const snapshot = useCallback(() => queue?.entries() ?? NO_ENTRIES, [queue]);
  return useSyncExternalStore(subscribe, snapshot);
}
