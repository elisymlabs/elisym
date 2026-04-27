import type { Agent, SubCloser } from '@elisym/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getAllAgentProfiles,
  migrateLegacyListSnapshot,
  setAgentProfiles,
} from '~/lib/agentProfileCache';
import { preloadFirstBatchPictures } from '~/lib/imagePreload';
import { useElisymClient } from './useElisymClient';

export type StreamStatus = 'idle' | 'streaming' | 'eose' | 'enriched';

export interface UseAgentsResult {
  agents: Agent[];
  status: StreamStatus;
  displayReady: boolean;
  error: Error | null;
}

export interface UseAgentsOptions {
  /**
   * Cold-start preload size. After enrichment, the hook waits (with a
   * `PRELOAD_TIMEOUT_MS` cap) for the first N agents' picture bytes to load
   * before flipping `displayReady`. Pass `0` to disable byte-preload (e.g.
   * the agent detail page does not depend on the discovery grid being
   * painted).
   */
  firstPaintBatchSize?: number;
}

export const NETWORK = 'devnet';

const PRELOAD_TIMEOUT_MS = 3000;
const MAX_FIRST_PAINT_MS = 8000;

type Patch = { type: 'agent'; agent: Agent } | { type: 'paidJob'; pubkey: string; ts: number };

export function useAgents(options: UseAgentsOptions = {}): UseAgentsResult {
  const { firstPaintBatchSize = 0 } = options;
  const { client } = useElisymClient();
  const agentMapRef = useRef<Map<string, Agent>>(new Map());
  const pendingRef = useRef<Patch[]>([]);
  const enrichedOrderRef = useRef<Agent[] | null>(null);
  const rafRef = useRef<number | null>(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [displayReady, setDisplayReady] = useState(false);
  const displayReadyRef = useRef(false);
  displayReadyRef.current = displayReady;

  useEffect(() => {
    let cancelled = false;
    let closer: SubCloser | null = null;
    let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
    // Defer IDB writes from per-frame patches until enrichment fires
    // `onComplete`. Pre-enrichment, streamed capability events lack
    // name/picture/banner/about, so persisting them would overwrite a
    // previously-cached enriched profile and cause the picture to vanish
    // until the next enrichment finishes.
    let enriched = false;

    const flush = () => {
      rafRef.current = null;
      const touchedPubkeys = new Set<string>();
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
          touchedPubkeys.add(patch.agent.pubkey);
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
            touchedPubkeys.add(patch.pubkey);
          }
        }
      }
      pendingRef.current = [];
      if (touchedPubkeys.size > 0) {
        if (enriched) {
          const changedAgents: Agent[] = [];
          for (const pubkey of touchedPubkeys) {
            const agent = agentMapRef.current.get(pubkey);
            if (agent) {
              changedAgents.push(agent);
            }
          }
          if (changedAgents.length > 0) {
            void setAgentProfiles(NETWORK, changedAgents);
          }
        }
        setVersion((prev) => prev + 1);
      }
    };

    const schedule = () => {
      if (rafRef.current !== null) {
        return;
      }
      rafRef.current = requestAnimationFrame(flush);
    };

    const seedFromCache = async () => {
      await migrateLegacyListSnapshot(NETWORK);
      const cached = await getAllAgentProfiles(NETWORK);
      if (cancelled || cached.length === 0) {
        return;
      }
      // Merge cached fields *under* live data so enriched profile fields
      // (name/picture/banner/about) survive the case where a streamed
      // capability event landed in the map before the IDB read resolved.
      // Live data still wins for any field it sets.
      for (const agent of cached) {
        const live = agentMapRef.current.get(agent.pubkey);
        agentMapRef.current.set(agent.pubkey, live ? { ...agent, ...live } : agent);
      }
      setStatus((prev) => (prev === 'idle' ? 'streaming' : prev));
      setVersion((prev) => prev + 1);
      // Warm-path first-paint: cached profiles already carry picture URLs
      // from a prior enrichment. Repeat visitors usually have the bytes in
      // the browser HTTP cache, so skip the byte-preload step and flip
      // immediately - matches today's near-instant warm render.
      setDisplayReady(true);
    };

    const open = (myGen: number) => {
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
          enriched = true;
          void setAgentProfiles(NETWORK, sortedAgents);
          setStatus('enriched');
          setVersion((prev) => prev + 1);
          // Cold-path first-paint: warm path already flipped `displayReady`,
          // so skip the redundant 18 GETs on warm reloads.
          if (displayReadyRef.current) {
            return;
          }
          void preloadFirstBatchPictures(
            sortedAgents,
            firstPaintBatchSize,
            PRELOAD_TIMEOUT_MS,
          ).then(() => {
            if (cancelled || myGen !== generation) {
              return;
            }
            setDisplayReady(true);
          });
        },
      });
    };

    // Generation token guards against parallel `init()` runs (e.g. a
    // `pool.onReset` firing while the previous seed is still awaiting).
    // Each `init` captures its generation; only the current one is allowed
    // to call `open()`. Block subscription on the IDB seed so a freshly
    // mounted hook never renders streamed agents (which carry no
    // name/picture/banner from `parseCapabilityEvent`) before the cached
    // enriched fields are merged in.
    let generation = 0;

    const scheduleCeiling = (myGen: number) => {
      if (ceilingTimer !== null) {
        clearTimeout(ceilingTimer);
      }
      ceilingTimer = setTimeout(() => {
        ceilingTimer = null;
        if (cancelled || myGen !== generation) {
          return;
        }
        // Hard floor: even if enrichment never reaches `onComplete` and the
        // cache was empty, flip `displayReady` so the user is not stuck on
        // skeletons forever. Falls back to today's "streaming with no
        // pictures" UX rather than something worse.
        setDisplayReady(true);
      }, MAX_FIRST_PAINT_MS);
    };

    const init = async (myGen: number) => {
      scheduleCeiling(myGen);
      await seedFromCache();
      if (cancelled || myGen !== generation) {
        return;
      }
      open(myGen);
    };

    void init(generation);

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
      enriched = false;
      setStatus('streaming');
      setDisplayReady(false);
      setVersion((prev) => prev + 1);
      generation += 1;
      void init(generation);
    });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (ceilingTimer !== null) {
        clearTimeout(ceilingTimer);
        ceilingTimer = null;
      }
      pendingRef.current = [];
      unregisterReset();
      closer?.close('unmount');
    };
  }, [client, firstPaintBatchSize]);

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

  return { agents, status, displayReady, error: null };
}
