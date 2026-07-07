/**
 * Nostr-only reputation tally (stage 1).
 *
 * The single source of truth for rating counters and the `lastPaidJobAt`
 * ranking bucket, shared by discovery enrichment and the web app (replacing the
 * app's unverified hand-rolled counting). Everything here is `verifyEvent`
 * (crypto) plus tag reads - **no Solana RPC**. On-chain payment verification and
 * verified paid volume are deferred to an off-chain indexer (see
 * docs/plans/agent-reputation-indexer.md); the payment tx signatures ride in the
 * events but are not checked here.
 *
 * Authorship is anchored to the job **request** event (content-addressed, so it
 * commits to the customer's pubkey), not the result's `p` tag (provider-written,
 * so a third party can forge it). A rating is Nostr-verified when the same key signed the
 * request and the rating, the request targeted exactly this agent, and the
 * provider delivered a result. Ratings that miss the strong anchor but pass the
 * legacy result-`p`-tag binding fall to the unverified tier (displayed, never a
 * ranking input). The same request-anchor gates `lastPaidJobAt`, so a third
 * party cannot mint another agent's recency bucket.
 */

import { verifyEvent, type Event } from 'nostr-tools';
import { KIND_JOB_FEEDBACK, KIND_JOB_REQUEST_BASE, KIND_JOB_RESULT_BASE } from '../constants';
import type { Network } from '../types';

export interface RatingTier {
  total: number;
  positive: number;
}

export interface CapabilityTiers {
  nostrVerified: RatingTier;
  unverified: RatingTier;
}

export interface AgentReputation {
  nostrVerified: RatingTier;
  unverified: RatingTier;
  /** Per-capability breakdown, keyed by the job request's capability tag. */
  byCapability: Record<string, CapabilityTiers>;
  /** Newest request-authored `payment-completed` timestamp (Unix sec). */
  lastPaidJobAt?: number;
  /** Tx signature of the job referenced by `lastPaidJobAt`. */
  lastPaidJobTx?: string;
  /** Newest verified activity (Unix sec) touching this agent - feeds `lastSeen`. */
  lastActivityAt?: number;
  /**
   * Reserved for the off-chain indexer - always undefined in stage 1. The
   * indexer verifies the carried tx signatures on-chain and fills this in.
   */
  paymentVerified?: {
    total: number;
    positive: number;
    volume: Record<string, string>;
  };
}

const ELISYM_TAG = 'elisym';
/** Single-valued tag names: a conflicting duplicate drops the whole event. */
const SINGLE_VALUED = ['e', 'p', 'rating', 'network', 'status'] as const;

/**
 * Read the first value of each single-valued tag. Returns `null` if any of them
 * appears more than once with differing values (a malformed / adversarial
 * event), in which case the caller drops the event entirely.
 */
function readSingleValued(
  event: Event,
): Record<(typeof SINGLE_VALUED)[number], string | undefined> | null {
  const out: Record<string, string | undefined> = {};
  for (const name of SINGLE_VALUED) {
    let value: string | undefined;
    for (const tag of event.tags) {
      if (tag[0] !== name) {
        continue;
      }
      if (value === undefined) {
        value = tag[1];
      } else if (tag[1] !== value) {
        return null; // conflicting duplicate
      }
    }
    out[name] = value;
  }
  return out;
}

/** First capability `t` tag (the first `t` value that is not `elisym`). */
function capabilityTag(event: Event): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 't' && tag[1] && tag[1] !== ELISYM_TAG) {
      return tag[1];
    }
  }
  return undefined;
}

/** The provider `p` tags on a request, deduped. Verified tier needs exactly one. */
function requestTargets(request: Event): string[] {
  const targets = new Set<string>();
  for (const tag of request.tags) {
    if (tag[0] === 'p' && tag[1]) {
      targets.add(tag[1]);
    }
  }
  return [...targets];
}

function isJobRequestKind(kind: number): boolean {
  return kind >= KIND_JOB_REQUEST_BASE && kind < KIND_JOB_RESULT_BASE;
}

function isJobResultKind(kind: number): boolean {
  return kind >= KIND_JOB_RESULT_BASE && kind < KIND_JOB_FEEDBACK;
}

function emptyReputation(): AgentReputation {
  return {
    nostrVerified: { total: 0, positive: 0 },
    unverified: { total: 0, positive: 0 },
    // Null-prototype: the capability key is an untrusted `t` tag, so a
    // `__proto__` / `constructor` value must land as a plain own key rather than
    // walk the prototype chain (which would pollute `Object.prototype` or make
    // the counter read `undefined.total` and throw out of the whole tally).
    byCapability: Object.create(null) as Record<string, CapabilityTiers>,
  };
}

function emptyCapabilityTiers(): CapabilityTiers {
  return {
    nostrVerified: { total: 0, positive: 0 },
    unverified: { total: 0, positive: 0 },
  };
}

/** Latest-wins by `created_at`, tie-broken by higher event id (deterministic). */
function isNewer(candidate: Event, current: Event): boolean {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at;
  }
  return candidate.id > current.id;
}

export interface TallyInput {
  /** Agents in scope; events targeting anyone else are ignored. */
  agentPubkeys: Iterable<string>;
  /** kind-6xxx provider results. */
  resultEvents: Event[];
  /** kind-7000 feedback (ratings + payment-completed). */
  feedbackEvents: Event[];
  /** kind-5xxx job requests, fetched by id (union of both feedback streams). */
  requestEvents: Event[];
  /** Client network; events whose `network` tag differs are ignored (missing => devnet). */
  network: Network;
}

/**
 * The job ids a caller must fetch request events for: the union of the `e`-tags
 * on ratings AND payment-completed feedback. Payment-completed is auto-published
 * on every paid job while ratings are optional, and free-job ratings have no
 * payment-completed - neither set contains the other, so the union is required
 * for the `lastPaidJobAt` binding to see request J on paid-but-unrated jobs.
 */
export function requestJobIds(feedbackEvents: Event[]): string[] {
  const ids = new Set<string>();
  for (const event of feedbackEvents) {
    if (event.kind !== KIND_JOB_FEEDBACK) {
      continue;
    }
    const jobId = event.tags.find((tag) => tag[0] === 'e')?.[1];
    if (jobId) {
      ids.add(jobId);
    }
  }
  return [...ids];
}

/**
 * Tally reputation for the agents in scope. Pure: verifies every event it reads
 * and never touches the network.
 */
export function tallyReputation(input: TallyInput): Map<string, AgentReputation> {
  const scope = new Set(input.agentPubkeys);
  const result = new Map<string, AgentReputation>();
  const get = (pubkey: string): AgentReputation => {
    let rep = result.get(pubkey);
    if (!rep) {
      rep = emptyReputation();
      result.set(pubkey, rep);
    }
    return rep;
  };
  // Clamp activity timestamps to now: a Nostr event can carry an arbitrary future
  // `created_at`, which would otherwise let anyone pin an agent to the top of a
  // recency sort by publishing a far-future event.
  const nowSecs = Math.floor(Date.now() / 1000);
  const bumpActivity = (pubkey: string, at: number): void => {
    const clamped = at > nowSecs ? nowSecs : at;
    const rep = get(pubkey);
    if (rep.lastActivityAt === undefined || clamped > rep.lastActivityAt) {
      rep.lastActivityAt = clamped;
    }
  };

  // Request events, verified, indexed by id. The authorship anchor.
  const requestById = new Map<string, Event>();
  for (const event of input.requestEvents) {
    if (!isJobRequestKind(event.kind) || !verifyEvent(event)) {
      continue;
    }
    requestById.set(event.id, event);
  }

  // Result events, verified. Delivered jobs per provider + the legacy
  // customer-by-job binding (result `p` tag) used only by the unverified tier.
  const deliveredByProvider = new Map<string, Set<string>>();
  const legacyCustomerByJob = new Map<string, string>();
  for (const event of input.resultEvents) {
    // Bounded to the result-kind range: without the upper bound a kind-7000
    // feedback event returned by a misbehaving relay would be miscounted as a
    // delivered result, minting spurious delivered-set / legacy-customer entries.
    if (!isJobResultKind(event.kind) || !verifyEvent(event)) {
      continue;
    }
    if (scope.has(event.pubkey)) {
      // Result events carry no `network` tag (unlike feedback, which is network-scoped
      // above), so activity is bumped cross-network. Harmless while devnet-only, but
      // once mainnet exists a devnet agent's `lastSeen` can reflect mainnet delivery.
      bumpActivity(event.pubkey, event.created_at);
    }
    const jobId = event.tags.find((tag) => tag[0] === 'e')?.[1];
    if (!jobId) {
      continue;
    }
    let delivered = deliveredByProvider.get(event.pubkey);
    if (!delivered) {
      delivered = new Set();
      deliveredByProvider.set(event.pubkey, delivered);
    }
    delivered.add(jobId);
    const customer = event.tags.find((tag) => tag[0] === 'p')?.[1];
    if (customer && !legacyCustomerByJob.has(jobId)) {
      legacyCustomerByJob.set(jobId, customer);
    }
  }

  // Dedupe feedback latest-wins per (author, jobId) and per stream (ratings vs
  // payment-completed share the (author, job) key shape). Winners carry the
  // resolved target agent and jobId so the tally does not re-parse them.
  interface FeedbackWinner {
    event: Event;
    targetPubkey: string;
    jobId: string;
    positive: boolean;
  }
  const ratingWinners = new Map<string, FeedbackWinner>();
  const paymentWinners = new Map<string, FeedbackWinner>();
  for (const event of input.feedbackEvents) {
    if (event.kind !== KIND_JOB_FEEDBACK || !verifyEvent(event)) {
      continue;
    }
    const tags = readSingleValued(event);
    if (!tags) {
      continue; // conflicting duplicate single-valued tag
    }
    const eventNetwork = tags.network ?? 'devnet';
    if (eventNetwork !== input.network) {
      continue;
    }
    const targetPubkey = tags.p;
    const jobId = tags.e;
    if (!targetPubkey || !jobId || !scope.has(targetPubkey)) {
      continue;
    }

    // Dedup identity is (rating author, jobId): a customer's latest verdict wins.
    const key = `${event.pubkey}:${jobId}`;
    const isRating = tags.rating === '1' || tags.rating === '0';
    if (isRating) {
      const current = ratingWinners.get(key);
      if (!current || isNewer(event, current.event)) {
        ratingWinners.set(key, { event, targetPubkey, jobId, positive: tags.rating === '1' });
      }
    } else if (tags.status === 'payment-completed') {
      const current = paymentWinners.get(key);
      if (!current || isNewer(event, current.event)) {
        paymentWinners.set(key, { event, targetPubkey, jobId, positive: false });
      }
    }
  }

  /**
   * Classify a feedback event's authorship against its job request.
   * `verified` when the request is fetchable, is a job-request kind, targets
   * exactly this agent, and its author equals the feedback author. Otherwise
   * `unverified` when the legacy result-`p`-tag binding holds. `null` => drop.
   */
  const classify = (
    event: Event,
    targetPubkey: string,
    jobId: string,
  ): { tier: 'verified' | 'unverified'; capability?: string } | null => {
    const hasDeliveredResult = deliveredByProvider.get(targetPubkey)?.has(jobId) === true;
    if (!hasDeliveredResult) {
      return null;
    }
    const request = requestById.get(jobId);
    if (request) {
      const targets = requestTargets(request);
      const strong =
        request.pubkey === event.pubkey && targets.length === 1 && targets[0] === targetPubkey;
      if (strong) {
        return { tier: 'verified', capability: capabilityTag(request) };
      }
    }
    // Legacy fallback: author must equal the customer the provider addressed.
    if (legacyCustomerByJob.get(jobId) === event.pubkey) {
      return { tier: 'unverified' };
    }
    return null;
  };

  for (const { event, targetPubkey, jobId, positive } of ratingWinners.values()) {
    const verdict = classify(event, targetPubkey, jobId);
    if (!verdict) {
      continue;
    }
    // Only a classifier-legit rating (delivered result + authorship binding) is
    // activity, so a third party publishing a `p=<victim>` feedback cannot inflate
    // the victim's lastSeen.
    bumpActivity(targetPubkey, event.created_at);
    const rep = get(targetPubkey);
    const tier = verdict.tier === 'verified' ? rep.nostrVerified : rep.unverified;
    tier.total += 1;
    if (positive) {
      tier.positive += 1;
    }
    // Per-capability only for the verified tier (keyed by the request's tag);
    // the unverified/fallback tier has no trusted capability, so agent-level only.
    if (verdict.tier === 'verified' && verdict.capability) {
      let caps = rep.byCapability[verdict.capability];
      if (!caps) {
        caps = emptyCapabilityTiers();
        rep.byCapability[verdict.capability] = caps;
      }
      caps.nostrVerified.total += 1;
      if (positive) {
        caps.nostrVerified.positive += 1;
      }
    }
  }

  for (const { event, targetPubkey, jobId } of paymentWinners.values()) {
    const verdict = classify(event, targetPubkey, jobId);
    // Only the strong request-anchor mints the ranking bucket - broadcast paid
    // jobs (no single `J.p`) and expired requests get no bucket.
    if (!verdict || verdict.tier !== 'verified') {
      continue;
    }
    bumpActivity(targetPubkey, event.created_at);
    const txSignature = event.tags.find((tag) => tag[0] === 'tx')?.[1];
    if (!txSignature) {
      continue;
    }
    const rep = get(targetPubkey);
    // Clamp to now like bumpActivity: `lastPaidJobAt` is the top ranking sort key,
    // and the customer signs `created_at`, so a future value would pin the provider
    // indefinitely.
    const paidAt = event.created_at > nowSecs ? nowSecs : event.created_at;
    if (rep.lastPaidJobAt === undefined || paidAt > rep.lastPaidJobAt) {
      rep.lastPaidJobAt = paidAt;
      rep.lastPaidJobTx = txSignature;
    }
  }

  return result;
}
