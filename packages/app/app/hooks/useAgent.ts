import type { Agent } from '@elisym/sdk';
import { useEffect, useState } from 'react';
import { getAgentProfile, setAgentProfiles } from '~/lib/agentProfileCache';
import { getAgentSnapshot, setAgentSnapshot } from '~/lib/agentSnapshotCache';
import { NETWORK } from './useAgents';
import { useElisymClient } from './useElisymClient';

export type AgentFetchStatus = 'idle' | 'loading' | 'ready' | 'not-found';

export interface UseAgentResult {
  agent: Agent | undefined;
  status: AgentFetchStatus;
}

const GRACE_MS = 1200;
const RETRY_DELAY_MS = 800;
const HARD_CEILING_MS = 12_000;
const MAX_ATTEMPTS = 2;

/**
 * Fetch a single agent by pubkey for the agent detail page.
 *
 * Hydration cascade keeps the page from blanking on transient relay misses:
 *   1. Synchronous read from `agentSnapshotCache` (Home/list page already
 *      loaded this agent in-session) - first paint shows the agent
 *      immediately, status `'ready'`.
 *   2. Async IDB read from `agentProfileCache` (prior session) - merged in
 *      if the snapshot was empty.
 *   3. `discovery.fetchAgent` over relays.
 *
 * Network policy:
 *   - Up to `MAX_ATTEMPTS` (initial + one retry) - a single empty response
 *     is treated as ambiguous, not authoritative.
 *   - `RETRY_DELAY_MS` between attempts.
 *   - `GRACE_MS` floor on attempt-to-NotFound transition so even a fast
 *     double-`null` waits before flashing NotFound.
 *   - `HARD_CEILING_MS` absolute timeout from mount; flips NotFound only
 *     after the snapshot/IDB fallbacks are also empty. Prevents an
 *     infinite spinner on hung sockets.
 *   - Network/relay errors stay silent (status pinned to `'loading'`)
 *     until the ceiling fires. Mirrors commit 2a4515d.
 */
export function useAgent(pubkey: string): UseAgentResult {
  const { client } = useElisymClient();
  const [agent, setAgent] = useState<Agent | undefined>(() =>
    pubkey ? getAgentSnapshot(NETWORK, pubkey) : undefined,
  );
  const [status, setStatus] = useState<AgentFetchStatus>(() => {
    if (!pubkey) {
      return 'idle';
    }
    return getAgentSnapshot(NETWORK, pubkey) ? 'ready' : 'loading';
  });

  useEffect(() => {
    if (!pubkey) {
      setAgent(undefined);
      setStatus('idle');
      return;
    }

    const initialSnapshot = getAgentSnapshot(NETWORK, pubkey);
    setAgent(initialSnapshot);
    setStatus(initialSnapshot ? 'ready' : 'loading');

    let cancelled = false;
    let resolved = initialSnapshot !== undefined;
    let networkSettled = false;
    let attemptCount = 0;
    let attemptStartedAt = 0;
    const mountedAt = performance.now();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const setTimer = (fn: () => void, ms: number) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        if (cancelled) {
          return;
        }
        fn();
      }, ms);
      timers.add(handle);
    };

    void getAgentProfile(NETWORK, pubkey).then((cached) => {
      if (cancelled || !cached || networkSettled) {
        return;
      }
      setAgent((prev) => prev ?? cached);
    });

    const finishWithFreshAgent = async (fresh: Agent) => {
      // Even when the relay returned an agent, the kind:0 metadata query
      // inside runEnrichment may have missed - leaving `fresh` without
      // name/picture/banner/about. Merge over the cached snapshot/IDB so
      // a transient metadata miss does not overwrite the cache with a
      // profile-less version. Mirrors the merge pattern in useAgents.ts
      // `onComplete`.
      const cached = await getAgentProfile(NETWORK, pubkey);
      if (cancelled) {
        return;
      }
      const merged: Agent = cached ? { ...cached, ...fresh } : fresh;
      networkSettled = true;
      resolved = true;
      setAgent(merged);
      setStatus('ready');
      void setAgentProfiles(NETWORK, [merged]);
      setAgentSnapshot(NETWORK, merged);
    };

    const flipNotFoundIfFinal = async () => {
      const cached = await getAgentProfile(NETWORK, pubkey);
      if (cancelled) {
        return;
      }
      if (cached) {
        resolved = true;
        setAgent((prev) => prev ?? cached);
        setStatus('ready');
        return;
      }
      const snapshot = getAgentSnapshot(NETWORK, pubkey);
      if (snapshot) {
        resolved = true;
        setAgent((prev) => prev ?? snapshot);
        setStatus('ready');
        return;
      }
      const elapsed = performance.now() - attemptStartedAt;
      const remaining = Math.max(0, GRACE_MS - elapsed);
      setTimer(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        setAgent(undefined);
        setStatus('not-found');
      }, remaining);
    };

    const attempt = async () => {
      attemptCount += 1;
      attemptStartedAt = performance.now();
      try {
        const fresh = await client.discovery.fetchAgent(NETWORK, pubkey);
        if (cancelled) {
          return;
        }
        if (!fresh) {
          if (attemptCount < MAX_ATTEMPTS) {
            setTimer(() => {
              void attempt();
            }, RETRY_DELAY_MS);
            return;
          }
          networkSettled = true;
          await flipNotFoundIfFinal();
          return;
        }
        await finishWithFreshAgent(fresh);
      } catch {
        // Network/relay error - keep whatever cache served and stay in
        // `loading` so the UI does not flash NotFound on a transient
        // failure. The hard-ceiling timer below is the last-resort exit.
      }
    };

    void attempt();

    const runCeilingFallback = async () => {
      const cached = await getAgentProfile(NETWORK, pubkey);
      if (cancelled || resolved) {
        return;
      }
      if (cached) {
        resolved = true;
        setAgent(cached);
        setStatus('ready');
        return;
      }
      const snapshot = getAgentSnapshot(NETWORK, pubkey);
      if (snapshot) {
        resolved = true;
        setAgent(snapshot);
        setStatus('ready');
        return;
      }
      resolved = true;
      setAgent(undefined);
      setStatus('not-found');
    };

    setTimer(
      () => {
        if (resolved) {
          return;
        }
        void runCeilingFallback();
      },
      Math.max(0, HARD_CEILING_MS - (performance.now() - mountedAt)),
    );

    const unregisterReset = client.pool.onReset(() => {
      if (cancelled || resolved) {
        return;
      }
      attemptCount = 0;
      networkSettled = false;
      setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
      void attempt();
    });

    return () => {
      cancelled = true;
      for (const handle of timers) {
        clearTimeout(handle);
      }
      timers.clear();
      unregisterReset();
    };
  }, [client, pubkey]);

  return { agent, status };
}
