import type { Agent } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { getAgentProfile } from '~/lib/agentProfileCache';
import { getAgentSnapshot } from '~/lib/agentSnapshotCache';
import { NETWORK } from './useAgents';

/**
 * Cache-only agent profile lookup (session snapshot, then IDB). Unlike
 * `useAgent` it never touches the network, so it is safe to mount per row
 * in lists (e.g. the DM conversation list) where a counterpart may not be
 * an agent at all - an unknown pubkey just resolves to `undefined`.
 */
export function useCachedAgentProfile(pubkey: string): Agent | undefined {
  const [agent, setAgent] = useState<Agent | undefined>(() => getAgentSnapshot(NETWORK, pubkey));

  useEffect(() => {
    setAgent(getAgentSnapshot(NETWORK, pubkey));
    let cancelled = false;
    void getAgentProfile(NETWORK, pubkey).then((cached) => {
      if (!cancelled && cached) {
        setAgent((prev) => prev ?? cached);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  return agent;
}
