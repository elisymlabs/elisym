import type { Agent } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { getAgentProfile, setAgentProfiles } from '~/lib/agentProfileCache';
import { NETWORK } from './useAgents';
import { useElisymClient } from './useElisymClient';

export type AgentFetchStatus = 'idle' | 'loading' | 'ready' | 'not-found';

export interface UseAgentResult {
  agent: Agent | undefined;
  status: AgentFetchStatus;
}

/**
 * Fetch a single agent by pubkey for the agent detail page.
 *
 * Seeds from the IndexedDB profile cache for instant render, then issues a
 * targeted `fetchAgent` (kind:31990 + kind:0 + paid-job enrichment, scoped to
 * one author) and replaces the cached snapshot with the enriched result. If
 * the network has no capability cards for this pubkey, status flips to
 * `not-found` so the caller can route to NotFound.
 */
export function useAgent(pubkey: string): UseAgentResult {
  const { client } = useElisymClient();
  const [agent, setAgent] = useState<Agent | undefined>(undefined);
  const [status, setStatus] = useState<AgentFetchStatus>('idle');

  useEffect(() => {
    if (!pubkey) {
      setAgent(undefined);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    // Once the network has resolved (ready or not-found), a late IDB read
    // must not resurrect a stale profile - otherwise an agent the network
    // says is gone keeps rendering from cache forever.
    let networkSettled = false;
    setAgent(undefined);
    setStatus('loading');

    void getAgentProfile(NETWORK, pubkey).then((cached) => {
      if (cancelled || !cached || networkSettled) {
        return;
      }
      setAgent((prev) => prev ?? cached);
    });

    const refetch = async () => {
      try {
        const fresh = await client.discovery.fetchAgent(NETWORK, pubkey);
        if (cancelled) {
          return;
        }
        networkSettled = true;
        if (!fresh) {
          setAgent(undefined);
          setStatus('not-found');
          return;
        }
        setAgent((prev) => (prev ? { ...prev, ...fresh } : fresh));
        setStatus('ready');
        void setAgentProfiles(NETWORK, [fresh]);
      } catch {
        if (cancelled) {
          return;
        }
        // Network/relay error - keep whatever the cache served and stay in
        // `loading` so the UI does not flash NotFound on a transient failure.
      }
    };

    void refetch();

    const unregisterReset = client.pool.onReset(() => {
      if (cancelled) {
        return;
      }
      setStatus('loading');
      void refetch();
    });

    return () => {
      cancelled = true;
      unregisterReset();
    };
  }, [client, pubkey]);

  return { agent, status };
}
