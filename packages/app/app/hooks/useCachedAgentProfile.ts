import type { Agent } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { getAgentProfile } from '~/lib/agentProfileCache';
import { NETWORK } from './useAgents';

export function useCachedAgentProfile(pubkey: string): Agent | undefined {
  const [profile, setProfile] = useState<Agent | undefined>(undefined);

  useEffect(() => {
    // Reset synchronously on pubkey change so the previous agent's profile
    // doesn't leak through to the new pubkey's render while the IDB read
    // is in flight.
    setProfile(undefined);
    if (!pubkey) {
      return;
    }
    let cancelled = false;
    void getAgentProfile(NETWORK, pubkey).then((cached) => {
      if (cancelled) {
        return;
      }
      setProfile(cached);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  return profile;
}
