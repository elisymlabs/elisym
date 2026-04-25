import type { Agent } from '@elisym/sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useElisymClient } from './useElisymClient';

class EmptyAgentsError extends Error {
  constructor() {
    super('Relays returned no agents (likely timeout or stale pool)');
    this.name = 'EmptyAgentsError';
  }
}

export function useAgents() {
  const { client, resetPool } = useElisymClient();

  const query = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: async () => {
      const agents = await client.discovery.fetchAgents('devnet', 1000);
      // `NostrPool.querySync` swallows relay timeouts and resolves to `[]`,
      // so React Query would otherwise cache an empty list as a success. On
      // devnet the registry is never actually empty - treat `[]` as a
      // transient failure so the retry/refetch logic below kicks in.
      if (agents.length === 0) {
        throw new EmptyAgentsError();
      }
      return agents;
    },
    // Exponential backoff with an upper bound so the user doesn't sit on
    // a spinner for minutes. 4 attempts at 0.75s / 1.5s / 3s ≈ 5s total
    // before giving up.
    retry: 3,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 3_000),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  // React Query v5 dropped onError - drop the SimplePool from an effect
  // instead. Stuck relay sockets are the most common cause of empty results
  // on devnet, so reconnect once when we finally give up.
  const resetOnceRef = useRef(false);
  useEffect(() => {
    if (query.isError && query.error instanceof EmptyAgentsError && !resetOnceRef.current) {
      resetOnceRef.current = true;
      resetPool();
      query.refetch();
    }
    if (!query.isError) {
      resetOnceRef.current = false;
    }
  }, [query.isError, query.error, query, resetPool]);

  return query;
}
