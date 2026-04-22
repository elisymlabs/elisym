import { KIND_JOB_FEEDBACK, KIND_JOB_REQUEST, KIND_JOB_RESULT } from '@elisym/sdk';
import { useRef } from 'react';
import { useElisymClient } from './useElisymClient';
import { useLocalQuery } from './useLocalQuery';

export interface FeedbackCounts {
  positive: number;
  negative: number;
  total: number;
  purchases: number;
}

/** Per-capability stats for a single agent */
export type CapabilityStatsMap = Record<string, FeedbackCounts>;

export interface AgentFeedbackEntry extends FeedbackCounts {
  /** capability d-tag → per-capability stats */
  byCapability: CapabilityStatsMap;
}

/** pubkey → AgentFeedbackEntry */
export type FeedbackMap = Record<string, AgentFeedbackEntry>;

/** Merge two maps, keeping the max of each field per pubkey */
function mergeMax(prev: FeedbackMap, next: FeedbackMap): FeedbackMap {
  const merged: FeedbackMap = { ...prev };
  for (const [key, val] of Object.entries(next)) {
    const p = merged[key];
    if (!p) {
      merged[key] = val;
    } else {
      merged[key] = {
        positive: Math.max(p.positive, val.positive),
        negative: Math.max(p.negative, val.negative),
        total: Math.max(p.total, val.total),
        purchases: Math.max(p.purchases, val.purchases),
        byCapability: mergeCapabilityMax(p.byCapability, val.byCapability),
      };
    }
  }
  return merged;
}

function mergeCapabilityMax(
  prev: CapabilityStatsMap,
  next: CapabilityStatsMap,
): CapabilityStatsMap {
  const merged: CapabilityStatsMap = { ...prev };
  for (const [key, val] of Object.entries(next)) {
    const p = merged[key];
    if (!p) {
      merged[key] = val;
    } else {
      merged[key] = {
        positive: Math.max(p.positive, val.positive),
        negative: Math.max(p.negative, val.negative),
        total: Math.max(p.total, val.total),
        purchases: Math.max(p.purchases, val.purchases),
      };
    }
  }
  return merged;
}

/**
 * Fetches feedback and purchase stats for a given set of agent pubkeys.
 * Builds both per-agent and per-capability groupings in a single pass.
 */
export function useAgentFeedback(agentPubkeys: string[]) {
  const { client } = useElisymClient();
  const highWater = useRef<FeedbackMap>({});

  // Stable key: sort and join so order doesn't cause refetches
  const pubkeysKey = agentPubkeys.slice().sort().join(',');

  return useLocalQuery<FeedbackMap>({
    queryKey: ['agent-feedback-v2', pubkeysKey],
    queryFn: async () => {
      if (agentPubkeys.length === 0) {
        return {};
      }

      const [feedbackEvents, jobRequests, jobResults] = await Promise.all([
        client.pool.querySync({
          kinds: [KIND_JOB_FEEDBACK],
          '#p': agentPubkeys,
        }),
        client.pool.querySync({
          kinds: [KIND_JOB_REQUEST],
          '#p': agentPubkeys,
        }),
        client.pool.querySync({
          kinds: [KIND_JOB_RESULT],
          authors: agentPubkeys,
        }),
      ]);

      // Dedup events by ID
      const seenFeedback = new Map<string, (typeof feedbackEvents)[0]>();
      for (const ev of feedbackEvents) {
        seenFeedback.set(ev.id, ev);
      }

      const seenRequests = new Map<string, (typeof jobRequests)[0]>();
      for (const req of jobRequests) {
        seenRequests.set(req.id, req);
      }

      const map: FeedbackMap = {};

      // Build set of request IDs that have a completed result
      const completedJobIds = new Set<string>();
      for (const res of jobResults) {
        const jobId = res.tags.find((t) => t[0] === 'e')?.[1];
        if (jobId) {
          completedJobIds.add(jobId);
        }
      }

      // Map job ID → { providerPubkey, capability } for feedback lookup
      const jobMeta = new Map<string, { provider: string; capability: string }>();

      for (const req of seenRequests.values()) {
        const providerPubkey = req.tags.find((t) => t[0] === 'p')?.[1];
        if (!providerPubkey) {
          continue;
        }

        const capability = req.tags.find((t) => t[0] === 't' && t[1] !== 'elisym')?.[1];

        if (!map[providerPubkey]) {
          map[providerPubkey] = {
            positive: 0,
            negative: 0,
            total: 0,
            purchases: 0,
            byCapability: {},
          };
        }

        const isCompleted = completedJobIds.has(req.id);

        if (capability) {
          jobMeta.set(req.id, { provider: providerPubkey, capability });
          if (!map[providerPubkey].byCapability[capability]) {
            map[providerPubkey].byCapability[capability] = {
              positive: 0,
              negative: 0,
              total: 0,
              purchases: 0,
            };
          }
          if (isCompleted) {
            map[providerPubkey].byCapability[capability].purchases++;
          }
        }
      }

      for (const ev of seenFeedback.values()) {
        const ratingTag = ev.tags.find((t) => t[0] === 'rating');
        if (!ratingTag) {
          continue;
        }

        const providerPubkey = ev.tags.find((t) => t[0] === 'p')?.[1];
        if (!providerPubkey) {
          continue;
        }

        if (!map[providerPubkey]) {
          map[providerPubkey] = {
            positive: 0,
            negative: 0,
            total: 0,
            purchases: 0,
            byCapability: {},
          };
        }

        const isPositive = ratingTag[1] === '1';
        if (isPositive) {
          map[providerPubkey].positive++;
        } else {
          map[providerPubkey].negative++;
        }
        map[providerPubkey].total++;

        // Per-capability feedback: prefer direct #t tag, fall back to jobMeta lookup
        const directCapability = ev.tags.find((t) => t[0] === 't' && t[1] !== 'elisym')?.[1];
        const jobId = ev.tags.find((t) => t[0] === 'e')?.[1];
        const capability = directCapability ?? (jobId ? jobMeta.get(jobId)?.capability : undefined);
        if (capability) {
          const capStats = map[providerPubkey].byCapability;
          if (!capStats[capability]) {
            capStats[capability] = {
              positive: 0,
              negative: 0,
              total: 0,
              purchases: 0,
            };
          }
          const cap = capStats[capability]!;
          if (isPositive) {
            cap.positive++;
          } else {
            cap.negative++;
          }
          cap.total++;
        }
      }

      // Derive agent-level purchases from per-capability totals (single source of truth)
      for (const entry of Object.values(map)) {
        entry.purchases = Object.values(entry.byCapability).reduce(
          (sum, s) => sum + s.purchases,
          0,
        );
      }

      // Never decrease — merge with high water mark
      highWater.current = mergeMax(highWater.current, map);
      return highWater.current;
    },
    cacheTransform: (cached) => {
      highWater.current = mergeMax(highWater.current, cached);
      return highWater.current;
    },
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
    enabled: agentPubkeys.length > 0,
  });
}
