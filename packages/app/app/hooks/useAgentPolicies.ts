import type { AgentPolicy } from '@elisym/sdk';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useElisymClient } from './useElisymClient';

/**
 * Fetch published agent policies (NIP-23 long-form articles tagged
 * `elisym-policy`). Lazy - only fires when `pubkey` is set, so the agent grid
 * does not pay for this query.
 */
export function useAgentPolicies(pubkey: string | undefined): UseQueryResult<AgentPolicy[], Error> {
  const { client } = useElisymClient();
  return useQuery({
    queryKey: ['agent-policies', pubkey ?? null],
    enabled: Boolean(pubkey),
    queryFn: () => {
      if (!pubkey) {
        throw new Error('pubkey is required');
      }
      return client.policies.fetchPolicies(pubkey);
    },
    staleTime: 5 * 60_000,
  });
}
