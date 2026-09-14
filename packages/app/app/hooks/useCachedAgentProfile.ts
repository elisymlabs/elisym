import type { Agent } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { getAgentProfile } from '~/lib/agentProfileCache';
import { getAgentSnapshot } from '~/lib/agentSnapshotCache';
import { SOLANA_CLUSTER } from '~/lib/cluster';

/**
 * Cache-only agent profile lookup (session snapshot, then IDB). Unlike
 * `useAgent` it never touches the network, so it is safe to mount per row
 * in lists (e.g. the DM conversation list) where a counterpart may not be
 * an agent at all - an unknown pubkey just resolves to `undefined`.
 */
export function useCachedAgentProfile(pubkey: string): Agent | undefined {
  const [agent, setAgent] = useState<Agent | undefined>(() =>
    getAgentSnapshot(SOLANA_CLUSTER, pubkey),
  );

  useEffect(() => {
    setAgent(getAgentSnapshot(SOLANA_CLUSTER, pubkey));
    let cancelled = false;
    void getAgentProfile(SOLANA_CLUSTER, pubkey).then((cached) => {
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
