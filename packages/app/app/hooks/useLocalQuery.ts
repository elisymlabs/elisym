import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { cacheGet, cacheSet } from '~/lib/localCache';

/**
 * Local-first useQuery: serves cached data from IndexedDB instantly,
 * then revalidates from the network in the background.
 */
export function useLocalQuery<T>(
  options: UseQueryOptions<T, Error, T, string[]> & {
    queryKey: string[];
    /** Transform cached data loaded from IndexedDB before using as initialData. */
    cacheTransform?: (data: T) => T;
  },
): UseQueryResult<T, Error> & { fromCache: boolean } {
  const cacheKey = options.queryKey.join(':');
  const [initialData, setInitialData] = useState<T | undefined>(undefined);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  // Track which cacheKey the initialData belongs to, so stale data
  // from a previous key is never passed to useQuery on the first render
  // after a key change (useState setters are async).
  const initialDataKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Reset state so stale data doesn't bleed across keys
    setCacheLoaded(false);
    setInitialData(undefined);
    setFromCache(false);
    initialDataKeyRef.current = undefined;

    let cancelled = false;
    cacheGet<T>(cacheKey).then((cached) => {
      if (cancelled) {
        return;
      }
      if (cached !== undefined) {
        setInitialData(options.cacheTransform ? options.cacheTransform(cached) : cached);
        setFromCache(true);
        initialDataKeyRef.current = cacheKey;
      }
      setCacheLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheTransform is intentionally excluded to avoid infinite loops
  }, [cacheKey]);

  // Only use initialData if it belongs to the current cacheKey
  const safeInitialData = initialDataKeyRef.current === cacheKey ? initialData : undefined;
  const safeFromCache = initialDataKeyRef.current === cacheKey ? fromCache : false;

  const query = useQuery<T, Error, T, string[]>({
    ...options,
    enabled: cacheLoaded && (options.enabled ?? true),
    initialData: safeInitialData,
    initialDataUpdatedAt: safeFromCache ? 0 : undefined, // always treat cached data as stale
  });

  // Persist fresh data back to IndexedDB
  useEffect(() => {
    if (query.data !== undefined && query.isFetchedAfterMount) {
      cacheSet(cacheKey, query.data);
      setFromCache(false);
    }
  }, [query.data, query.isFetchedAfterMount, cacheKey]);

  return { ...query, fromCache: safeFromCache };
}
