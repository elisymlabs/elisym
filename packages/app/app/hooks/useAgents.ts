import type { Agent, SubCloser } from '@elisym/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cacheGet, cacheSet } from '~/lib/localCache';
import { useElisymClient } from './useElisymClient';

export type StreamStatus = 'idle' | 'streaming' | 'eose' | 'enriched';

export interface UseAgentsResult {
  agents: Agent[];
  status: StreamStatus;
  error: Error | null;
}

const NETWORK = 'devnet';

type Patch = { type: 'agent'; agent: Agent } | { type: 'paidJob'; pubkey: string; ts: number };

export function useAgents(): UseAgentsResult {
  const { client } = useElisymClient();
  const agentMapRef = useRef<Map<string, Agent>>(new Map());
  const pendingRef = useRef<Patch[]>([]);
  const enrichedOrderRef = useRef<Agent[] | null>(null);
  const rafRef = useRef<number | null>(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<StreamStatus>('idle');

  useEffect(() => {
    let cancelled = false;
    let closer: SubCloser | null = null;

    const flush = () => {
      rafRef.current = null;
      let touched = false;
      for (const patch of pendingRef.current) {
        if (patch.type === 'agent') {
          const prior = agentMapRef.current.get(patch.agent.pubkey);
          // Spread prior under patch.agent so enriched fields not present on
          // a streamed capability event (name/picture/banner/about, rating
          // counts, lastPaidJobAt/Tx) survive a re-emit. parseCapabilityEvent
          // omits those keys entirely, so they fall through cleanly.
          const next: Agent = prior ? { ...prior, ...patch.agent } : { ...patch.agent };
          if (prior && prior.lastSeen > next.lastSeen) {
            next.lastSeen = prior.lastSeen;
          }
          agentMapRef.current.set(patch.agent.pubkey, next);
          touched = true;
        } else {
          const existing = agentMapRef.current.get(patch.pubkey);
          // Don't overwrite a verified `lastPaidJobAt` from enrichment.
          // Enrichment is the only producer of `lastPaidJobTx` and only sets
          // it after cross-checking customer `payment-completed` feedback
          // against a matching delivered result. A bare kind:6100 event has
          // no such cross-check, so accepting it post-enrichment would
          // regress the sybil mitigation.
          if (
            existing &&
            !existing.lastPaidJobTx &&
            (!existing.lastPaidJobAt || patch.ts > existing.lastPaidJobAt)
          ) {
            agentMapRef.current.set(patch.pubkey, { ...existing, lastPaidJobAt: patch.ts });
            touched = true;
          }
        }
      }
      pendingRef.current = [];
      if (touched) {
        setVersion((prev) => prev + 1);
      }
    };

    const schedule = () => {
      if (rafRef.current !== null) {
        return;
      }
      rafRef.current = requestAnimationFrame(flush);
    };

    const cacheKey = `agents:${NETWORK}`;
    void cacheGet<Agent[]>(cacheKey).then((cached) => {
      if (cancelled || !cached || cached.length === 0) {
        return;
      }
      // Seed only if no live event has arrived yet, otherwise we would
      // overwrite fresher data with the snapshot.
      if (agentMapRef.current.size > 0) {
        return;
      }
      for (const agent of cached) {
        agentMapRef.current.set(agent.pubkey, agent);
      }
      setStatus((prev) => (prev === 'idle' ? 'streaming' : prev));
      setVersion((prev) => prev + 1);
    });

    const open = () => {
      closer = client.discovery.streamAgents(NETWORK, {
        onAgent: (agent) => {
          pendingRef.current.push({ type: 'agent', agent });
          schedule();
          setStatus((prev) => (prev === 'idle' ? 'streaming' : prev));
        },
        onPaidJob: (pubkey, ts) => {
          pendingRef.current.push({ type: 'paidJob', pubkey, ts });
          schedule();
        },
        onEose: () => {
          setStatus((prev) => (prev === 'enriched' ? prev : 'eose'));
        },
        onComplete: (sortedAgents) => {
          // Upsert (don't clear) so capability events that arrived between
          // the SDK's caps-EOSE snapshot and `onComplete` survive. The SDK's
          // enrichment never removes agents from the snapshot, only mutates
          // them in place, so a clear-and-replace would only ever discard
          // legitimate live newcomers received during the enrichment window.
          for (const agent of sortedAgents) {
            agentMapRef.current.set(agent.pubkey, agent);
          }
          enrichedOrderRef.current = sortedAgents;
          void cacheSet(cacheKey, sortedAgents);
          setStatus('enriched');
          setVersion((prev) => prev + 1);
        },
      });
    };

    open();

    const unregisterReset = client.pool.onReset(() => {
      closer?.close('pool reset');
      closer = null;
      enrichedOrderRef.current = null;
      agentMapRef.current.clear();
      pendingRef.current = [];
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setStatus('streaming');
      setVersion((prev) => prev + 1);
      open();
    });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = [];
      unregisterReset();
      closer?.close('unmount');
    };
  }, [client]);

  const agents = useMemo<Agent[]>(() => {
    void version;
    const map = agentMapRef.current;
    if (status === 'enriched' && enrichedOrderRef.current) {
      // Preserve the enrichment sort order, but read each agent through the
      // live map so post-enrichment patches (onPaidJob, late onAgent) reach
      // the UI. Append any agents that arrived after enrichment in lastSeen
      // order so newcomers become visible without waiting for a pool reset.
      const seen = new Set<string>();
      const result: Agent[] = [];
      for (const agent of enrichedOrderRef.current) {
        const live = map.get(agent.pubkey);
        if (live) {
          result.push(live);
          seen.add(agent.pubkey);
        }
      }
      const newcomers: Agent[] = [];
      for (const [pubkey, agent] of map) {
        if (!seen.has(pubkey)) {
          newcomers.push(agent);
        }
      }
      newcomers.sort((a, b) => b.lastSeen - a.lastSeen);
      return result.concat(newcomers);
    }
    return Array.from(map.values()).sort((a, b) => {
      const aPaid = a.lastPaidJobAt ?? -Infinity;
      const bPaid = b.lastPaidJobAt ?? -Infinity;
      if (bPaid !== aPaid) {
        return bPaid - aPaid;
      }
      return b.lastSeen - a.lastSeen;
    });
  }, [version, status]);

  return { agents, status, error: null };
}
