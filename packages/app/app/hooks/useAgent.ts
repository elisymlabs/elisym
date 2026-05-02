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
 * one author) and merges the result over the cached snapshot. Two relay-miss
 * fallbacks keep the profile from blanking on a transient failure:
 * 1. If `fetchAgent` returns nothing, the IDB cache is used as a fallback;
 *    status only flips to `not-found` when both the relay and the cache are
 *    empty.
 * 2. If `fetchAgent` returns an agent but the kind:0 sub-query inside
 *    enrichment missed, `name`/`picture`/`banner`/`about` are absent on the
 *    fresh result. Spread `fresh` over the cached snapshot (and persist the
 *    merged version) so a metadata miss does not overwrite the cache with a
 *    profile-less snapshot. Mirrors `useAgents.ts` `onComplete`.
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
    // Once the relay has returned a fresh profile, a late IDB read must not
    // overwrite the merged version with the older cached snapshot. When the
    // relay returns nothing, the cache is used as a fallback (see the
    // `!fresh` branch below) so a transient relay miss does not blank out
    // an agent the user just saw on the previous page.
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
          const cached = await getAgentProfile(NETWORK, pubkey);
          if (cancelled) {
            return;
          }
          if (cached) {
            setAgent((prev) => prev ?? cached);
            setStatus('ready');
          } else {
            setAgent(undefined);
            setStatus('not-found');
          }
          return;
        }
        // Even when the relay returned an agent, the kind:0 metadata query
        // inside runEnrichment may have missed - leaving `fresh` without
        // name/picture/banner/about. Merge `fresh` over the cached snapshot
        // and persist the merged result so a transient metadata miss does
        // not overwrite the cache with a profile-less version. Mirrors the
        // merge pattern in useAgents.ts `onComplete`.
        const cached = await getAgentProfile(NETWORK, pubkey);
        if (cancelled) {
          return;
        }
        const merged: Agent = cached ? { ...cached, ...fresh } : fresh;
        setAgent(merged);
        setStatus('ready');
        void setAgentProfiles(NETWORK, [merged]);
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
