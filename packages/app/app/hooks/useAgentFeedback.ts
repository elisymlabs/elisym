import {
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  tallyReputation,
  type RatingTier,
} from '@elisym/sdk';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import type { StreamStatus } from './useAgents';
import { useElisymClient } from './useElisymClient';
import { useLocalQuery } from './useLocalQuery';

export interface CapabilityStats {
  /** Ratings whose author also signed the job request (Nostr-verified). */
  nostrVerified: RatingTier;
  /** Ratings that passed only the weaker result-`p`-tag binding. */
  unverified: RatingTier;
  purchases: number;
}

/** capability d-tag -> per-capability stats */
export type CapabilityStatsMap = Record<string, CapabilityStats>;

export interface AgentFeedbackEntry {
  nostrVerified: RatingTier;
  unverified: RatingTier;
  purchases: number;
  byCapability: CapabilityStatsMap;
}

/** pubkey -> AgentFeedbackEntry */
export type FeedbackMap = Record<string, AgentFeedbackEntry>;

function emptyTier(): RatingTier {
  return { total: 0, positive: 0 };
}

function capabilityOf(event: { tags: string[][] }): string | undefined {
  return event.tags.find((tag) => tag[0] === 't' && tag[1] !== 'elisym')?.[1];
}

/**
 * Fetches rating and purchase stats for a set of agent pubkeys.
 *
 * Rating counting is delegated to the SDK reputation tally (Nostr-verified via
 * request-event authorship; no `verifyEvent` bypass, no RPC). `purchases`
 * (completed-jobs count) is kept as a separate activity metric derived from
 * job requests and results. Counts can legitimately decrease (latest-wins
 * dedupe), so there is no high-water merge.
 *
 * `streamStatus` gates the network fetch: if provided, the query waits for the
 * discovery stream to finish enumerating agents (`'eose'` / `'enriched'`)
 * before issuing the query.
 */
export function useAgentFeedback(agentPubkeys: string[], streamStatus?: StreamStatus) {
  const { client } = useElisymClient();

  // Stable key: sort and join so order doesn't cause refetches
  const pubkeysKey = agentPubkeys.slice().sort().join(',');
  const streamReady =
    streamStatus === undefined || streamStatus === 'eose' || streamStatus === 'enriched';

  return useLocalQuery<FeedbackMap>({
    queryKey: ['agent-feedback-v3', pubkeysKey],
    queryFn: async () => {
      if (agentPubkeys.length === 0) {
        return {};
      }

      const [feedbackEvents, jobRequests, jobResults] = await Promise.all([
        client.pool.querySync({ kinds: [KIND_JOB_FEEDBACK], '#p': agentPubkeys }),
        client.pool.querySync({ kinds: [KIND_JOB_REQUEST], '#p': agentPubkeys }),
        client.pool.querySync({ kinds: [KIND_JOB_RESULT], authors: agentPubkeys }),
      ]);

      // Nostr-verified rating tally (request-authorship anchored). The #p-fetched
      // requests are the authorship anchors; the tally matches them by id.
      const reputation = tallyReputation({
        agentPubkeys,
        feedbackEvents,
        resultEvents: jobResults,
        requestEvents: jobRequests,
        network: SOLANA_CLUSTER,
      });

      // Purchases: a job request whose id has a matching provider result is a
      // completed job, credited to the agent that AUTHORED the result (kind:6100) -
      // NOT the request's `p` tag, which is a customer-written target hint that a
      // broadcast/multi-target request can point at anyone. `jobResults` is fetched
      // with `authors: agentPubkeys`, so the author is the agent that did the work.
      // Kept unverified (an activity signal, not a trust signal).
      const resultAuthorByJobId = new Map<string, string>();
      for (const result of jobResults) {
        const jobId = result.tags.find((tag) => tag[0] === 'e')?.[1];
        if (jobId && !resultAuthorByJobId.has(jobId)) {
          resultAuthorByJobId.set(jobId, result.pubkey);
        }
      }

      // Null-prototype: `map` is keyed by a provider pubkey taken from a raw relay
      // event (not verified in this fold) and `byCapability` by an untrusted `t`
      // tag - a `__proto__` value must land as a plain own key rather than walk the
      // prototype chain (prototype pollution / bogus reads).
      const map: FeedbackMap = Object.create(null) as FeedbackMap;
      const entryFor = (pubkey: string): AgentFeedbackEntry => {
        let entry = map[pubkey];
        if (!entry) {
          entry = {
            nostrVerified: emptyTier(),
            unverified: emptyTier(),
            purchases: 0,
            byCapability: Object.create(null) as CapabilityStatsMap,
          };
          map[pubkey] = entry;
        }
        return entry;
      };
      const capabilityStatsFor = (
        entry: AgentFeedbackEntry,
        capability: string,
      ): CapabilityStats => {
        let stats = entry.byCapability[capability];
        if (!stats) {
          stats = { nostrVerified: emptyTier(), unverified: emptyTier(), purchases: 0 };
          entry.byCapability[capability] = stats;
        }
        return stats;
      };

      // Fold the rating tiers in from the SDK tally.
      for (const [pubkey, rep] of reputation) {
        const entry = entryFor(pubkey);
        entry.nostrVerified = rep.nostrVerified;
        entry.unverified = rep.unverified;
        for (const [capability, tiers] of Object.entries(rep.byCapability)) {
          const stats = capabilityStatsFor(entry, capability);
          stats.nostrVerified = tiers.nostrVerified;
          stats.unverified = tiers.unverified;
        }
      }

      // Fold purchases in from completed job requests.
      const seenRequestIds = new Set<string>();
      for (const request of jobRequests) {
        const providerPubkey = resultAuthorByJobId.get(request.id);
        if (!providerPubkey || seenRequestIds.has(request.id)) {
          continue;
        }
        seenRequestIds.add(request.id);
        const entry = entryFor(providerPubkey);
        entry.purchases += 1;
        const capability = capabilityOf(request);
        if (capability) {
          capabilityStatsFor(entry, capability).purchases += 1;
        }
      }

      return map;
    },
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
    enabled: agentPubkeys.length > 0 && streamReady,
  });
}
