import { nip19, finalizeEvent, verifyEvent, type Filter, type Event } from 'nostr-tools';
import {
  KIND_APP_HANDLER,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_REQUEST_BASE,
  KIND_JOB_RESULT,
  KIND_JOB_RESULT_BASE,
  jobResultKind,
  DEFAULT_KIND_OFFSET,
  LIMITS,
} from '../constants';
import type { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type { Agent, CapabilityCard, Network, SubCloser } from '../types';

const RANKING_ACTIVITY_WINDOW_SECS = 30 * 24 * 60 * 60;
const RANKING_BUCKET_SIZE_SECS = 60;
const COLD_START_BUCKET = -Infinity;

/** Sentinel signal that never aborts; lets `runEnrichment` accept an `AbortSignal` uniformly. */
const NEVER_ABORTED_SIGNAL: AbortSignal = new AbortController().signal;

/** Convert a capability name to its Nostr d-tag form (ASCII-only, lowercase, hyphen-separated). */
export function toDTag(name: string): string {
  const tag = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, (ch) => '_' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!tag) {
    throw new Error('Capability name must contain at least one ASCII alphanumeric character.');
  }
  return tag;
}

/** Sort key derived from an Agent. Higher bucket / rate / lastPaidJobAt = ranks higher. */
export interface RankKey {
  /** Floor-to-minute timestamp of the agent's last verified paid job. `-Infinity` for cold start. */
  bucket: number;
  /** Positive review rate in `[0, 1]`. 0 when the agent has no rated feedback. */
  rate: number;
  /** Raw `lastPaidJobAt` (Unix sec) for tiebreak inside a bucket. 0 for cold start. */
  lastPaidJobAt: number;
  /** Final tiebreak; orders cold-start agents by NIP-89 freshness. */
  lastSeen: number;
}

export function computeRankKey(agent: Agent): RankKey {
  const lastPaidJobAt = agent.lastPaidJobAt ?? 0;
  const total = agent.totalRatingCount ?? 0;
  const positive = agent.positiveCount ?? 0;
  const rate = total > 0 ? positive / total : 0;
  const bucket =
    lastPaidJobAt > 0
      ? Math.floor(lastPaidJobAt / RANKING_BUCKET_SIZE_SECS) * RANKING_BUCKET_SIZE_SECS
      : COLD_START_BUCKET;
  return { bucket, rate, lastPaidJobAt, lastSeen: agent.lastSeen };
}

export function compareAgentsByRank(a: Agent, b: Agent): number {
  const ka = computeRankKey(a);
  const kb = computeRankKey(b);
  if (kb.bucket !== ka.bucket) {
    return kb.bucket - ka.bucket;
  }
  if (kb.rate !== ka.rate) {
    return kb.rate - ka.rate;
  }
  if (kb.lastPaidJobAt !== ka.lastPaidJobAt) {
    return kb.lastPaidJobAt - ka.lastPaidJobAt;
  }
  return kb.lastSeen - ka.lastSeen;
}

/**
 * Parse a single NIP-89 capability event into a one-card Agent.
 *
 * Returns `null` if the event fails signature verification, content schema
 * checks, or the `network` filter. The returned Agent's `supportedKinds`
 * holds only this event's `k` tags - merging across multiple events for the
 * same author is the caller's responsibility.
 */
export function parseCapabilityEvent(event: Event, network: Network): Agent | null {
  if (!verifyEvent(event)) {
    return null;
  }
  if (!event.content) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !candidate.name) {
    return null;
  }
  if (typeof candidate.description !== 'string') {
    return null;
  }
  if (
    !Array.isArray(candidate.capabilities) ||
    !candidate.capabilities.every((cap: unknown) => typeof cap === 'string')
  ) {
    return null;
  }
  if (candidate.deleted) {
    return null;
  }
  const card = candidate as unknown as CapabilityCard & { deleted?: boolean };

  if (
    card.payment &&
    (typeof card.payment.chain !== 'string' ||
      typeof card.payment.network !== 'string' ||
      typeof card.payment.address !== 'string')
  ) {
    return null;
  }

  if (
    card.payment?.job_price !== null &&
    card.payment?.job_price !== undefined &&
    (!Number.isInteger(card.payment.job_price) || card.payment.job_price < 0)
  ) {
    return null;
  }

  const agentNetwork = card.payment?.network ?? 'devnet';
  if (agentNetwork !== network) {
    return null;
  }

  const kTags = event.tags
    .filter((tag) => tag[0] === 'k')
    .map((tag) => parseInt(tag[1] ?? '', 10))
    .filter((kind) => !isNaN(kind));

  return {
    pubkey: event.pubkey,
    npub: nip19.npubEncode(event.pubkey),
    cards: [card],
    eventId: event.id,
    supportedKinds: kTags,
    lastSeen: event.created_at,
  };
}

/**
 * Deduplicate events by (pubkey, d-tag) keeping only the newest,
 * then build an Agent map filtered by network.
 */
function buildAgentsFromEvents(events: Event[], network: Network): Map<string, Agent> {
  // Deduplicate by author + d-tag, keeping only the newest event.
  // Verify here (not in `parseCapabilityEvent` alone) so a forged event with
  // a future `created_at` cannot displace a legitimate event from the dedup
  // map and effectively erase the victim's agent from results.
  const latestByDTag = new Map<string, Event>();
  for (const event of events) {
    if (!verifyEvent(event)) {
      continue;
    }
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
    const key = `${event.pubkey}:${dTag}`;
    const prev = latestByDTag.get(key);
    if (!prev || event.created_at > prev.created_at) {
      latestByDTag.set(key, event);
    }
  }

  // Per-pubkey accumulator. We track per-card `createdAt` + `kTags` so
  // `supportedKinds` is recomputed from only the surviving (name-dedup'd)
  // cards, matching the pre-refactor behavior.
  interface Accum {
    agent: Agent;
    perCard: Map<string, { createdAt: number; kTags: number[] }>;
  }
  const accumMap = new Map<string, Accum>();

  for (const event of latestByDTag.values()) {
    const parsed = parseCapabilityEvent(event, network);
    if (!parsed) {
      continue;
    }
    const card = parsed.cards[0]!;
    const cardKinds = parsed.supportedKinds;
    const createdAt = parsed.lastSeen;

    const existing = accumMap.get(parsed.pubkey);
    if (existing) {
      const prevForName = existing.perCard.get(card.name);
      if (prevForName) {
        if (createdAt >= prevForName.createdAt) {
          const idx = existing.agent.cards.findIndex(
            (existingCard) => existingCard.name === card.name,
          );
          if (idx >= 0) {
            existing.agent.cards[idx] = card;
          }
          existing.perCard.set(card.name, { createdAt, kTags: cardKinds });
        }
      } else {
        existing.agent.cards.push(card);
        existing.perCard.set(card.name, { createdAt, kTags: cardKinds });
      }
      if (createdAt > existing.agent.lastSeen) {
        existing.agent.lastSeen = createdAt;
        existing.agent.eventId = parsed.eventId;
      }
    } else {
      accumMap.set(parsed.pubkey, {
        agent: parsed,
        perCard: new Map([[card.name, { createdAt, kTags: cardKinds }]]),
      });
    }
  }

  const agentMap = new Map<string, Agent>();
  for (const [pubkey, acc] of accumMap) {
    const kindsSet = new Set<number>();
    for (const { kTags } of acc.perCard.values()) {
      for (const kind of kTags) {
        kindsSet.add(kind);
      }
    }
    acc.agent.supportedKinds = [...kindsSet];
    agentMap.set(pubkey, acc.agent);
  }

  return agentMap;
}

export class DiscoveryService {
  constructor(private pool: NostrPool) {}

  /**
   * Fetch a single page of elisym agents with relay-side pagination.
   * Uses `until` cursor for Nostr cursor-based pagination.
   *
   * Unlike `fetchAgents`, this method does NOT enrich agents with
   * kind:0 metadata (name, picture, about) or update `lastSeen` from
   * recent job activity. Call `enrichWithMetadata()` separately if needed.
   */
  async fetchAgentsPage(
    network: Network = 'devnet',
    limit = 20,
    until?: number,
  ): Promise<{ agents: Agent[]; oldestCreatedAt: number | null; rawEventCount: number }> {
    const filter: Filter = {
      kinds: [KIND_APP_HANDLER],
      '#t': ['elisym'],
      limit,
    };
    if (until !== undefined) {
      filter.until = until;
    }

    const events = await this.pool.querySync(filter);
    const rawEventCount = events.length;

    // Compute cursor from ALL raw events (before any filtering)
    let oldestCreatedAt: number | null = null;
    for (const event of events) {
      if (oldestCreatedAt === null || event.created_at < oldestCreatedAt) {
        oldestCreatedAt = event.created_at;
      }
    }

    const agentMap = buildAgentsFromEvents(events, network);

    const agents = Array.from(agentMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);

    return { agents, oldestCreatedAt, rawEventCount };
  }

  /** Enrich agents with kind:0 metadata (name, picture, about). Mutates in place and returns the same array. */
  async enrichWithMetadata(agents: Agent[]): Promise<Agent[]> {
    const pubkeys = agents.map((a) => a.pubkey);
    if (pubkeys.length === 0) {
      return agents;
    }

    const metaEvents = await this.pool.queryBatched(
      { kinds: [0] } as Omit<Filter, 'authors'>,
      pubkeys,
    );
    const latestMeta = new Map<string, (typeof metaEvents)[0]>();
    for (const ev of metaEvents) {
      if (!verifyEvent(ev)) {
        continue;
      }
      const prev = latestMeta.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) {
        latestMeta.set(ev.pubkey, ev);
      }
    }
    const agentLookup = new Map(agents.map((a) => [a.pubkey, a]));
    for (const [pubkey, ev] of latestMeta) {
      const agent = agentLookup.get(pubkey);
      if (!agent) {
        continue;
      }
      try {
        const meta = JSON.parse(ev.content);
        if (typeof meta.picture === 'string') {
          agent.picture = meta.picture;
        }
        if (typeof meta.banner === 'string') {
          agent.banner = meta.banner;
        }
        if (typeof meta.name === 'string') {
          agent.name = meta.name;
        }
        if (typeof meta.about === 'string') {
          agent.about = meta.about;
        }
      } catch {
        // skip malformed metadata
      }
    }
    return agents;
  }

  /**
   * Fetch elisym agents filtered by network, ranked by paid-job recency and
   * positive-feedback rate.
   *
   * Ranking algorithm:
   * 1. Bucket each agent into 1-minute slots by `lastPaidJobAt` (newest
   *    `payment-completed` feedback timestamp, gated by a matching kind:6xxx
   *    result from the provider on the same job event). Cold-start agents go
   *    into a sentinel bucket below all populated buckets.
   * 2. Within a bucket, sort by positive review rate descending.
   * 3. Tiebreak by raw `lastPaidJobAt`, then `lastSeen` (NIP-89 freshness).
   *
   * NOTE: We do not verify the `tx` signature on-chain - public Solana devnet
   * RPC rate-limits trivially exceed what discovery needs (N agents * up-to-5
   * candidates), and the resulting 429s blocked discovery entirely. As a
   * lighter sybil mitigation we cross-check `payment-completed` feedback
   * against a kind:6xxx result event authored by the provider on the same
   * job: a customer can publish a fake `payment-completed`, but they cannot
   * forge a result event signed by the provider. Tighten with recipient-tied
   * on-chain checks when the network moves to mainnet with a paid RPC
   * provider.
   */
  async fetchAgents(network: Network = 'devnet', limit?: number): Promise<Agent[]> {
    const filter: Filter = {
      kinds: [KIND_APP_HANDLER],
      '#t': ['elisym'],
    };
    if (limit !== undefined) {
      filter.limit = limit;
    }
    const events = await this.pool.querySync(filter);

    const agentMap = buildAgentsFromEvents(events, network);
    const agents = Array.from(agentMap.values());

    return this.runEnrichment(agents, agentMap, NEVER_ABORTED_SIGNAL);
  }

  /**
   * Fetch a single agent by pubkey, fully enriched (kind:0 metadata,
   * cross-checked `lastPaidJobAt`, rating counters). Returns `null` if the
   * pubkey has no surviving capability cards on the requested network.
   *
   * Use this when navigating directly to an agent's page; running
   * `fetchAgents`/`streamAgents` for that case streams the entire marketplace
   * just to find one author.
   */
  async fetchAgent(network: Network, pubkey: string): Promise<Agent | null> {
    const events = await this.pool.querySync({
      kinds: [KIND_APP_HANDLER],
      '#t': ['elisym'],
      authors: [pubkey],
    });

    const agentMap = buildAgentsFromEvents(events, network);
    if (agentMap.size === 0) {
      return null;
    }
    const agents = Array.from(agentMap.values());
    await this.runEnrichment(agents, agentMap, NEVER_ABORTED_SIGNAL);
    return agentMap.get(pubkey) ?? null;
  }

  /**
   * Enrich an agent map with paid-job stats, feedback counters, and kind:0
   * metadata, then return them sorted by `compareAgentsByRank`. Mutates the
   * passed-in `Agent` objects in place.
   *
   * Shared between `fetchAgents` (one-shot) and `streamAgents` (post-EOSE
   * second pass). The `signal` short-circuits the post-query work; in-flight
   * pool queries are not cancellable today (they fall through to the standard
   * timeout) and the caller drops the resolved value.
   */
  private async runEnrichment(
    agents: Agent[],
    agentMap: Map<string, Agent>,
    signal: AbortSignal,
  ): Promise<Agent[]> {
    const agentPubkeys = Array.from(agentMap.keys());
    if (agentPubkeys.length === 0) {
      return agents;
    }

    const activitySince = Math.floor(Date.now() / 1000) - RANKING_ACTIVITY_WINDOW_SECS;
    // Derive result kinds from agents' supported request kinds (5xxx - 6xxx)
    const resultKinds = new Set<number>();
    for (const agent of agentMap.values()) {
      for (const supportedKind of agent.supportedKinds) {
        if (supportedKind >= KIND_JOB_REQUEST_BASE && supportedKind < KIND_JOB_RESULT_BASE) {
          resultKinds.add(KIND_JOB_RESULT_BASE + (supportedKind - KIND_JOB_REQUEST_BASE));
        }
      }
    }
    resultKinds.add(jobResultKind(DEFAULT_KIND_OFFSET));

    const [resultEvents, feedbackEvents] = await Promise.all([
      this.pool.queryBatched(
        {
          kinds: [...resultKinds],
          since: activitySince,
        } as Omit<Filter, 'authors'>,
        agentPubkeys,
      ),
      this.pool.queryBatchedByTag(
        { kinds: [KIND_JOB_FEEDBACK], since: activitySince } as Filter,
        'p',
        agentPubkeys,
      ),
      this.enrichWithMetadata(agents),
    ]);

    if (signal.aborted) {
      return agents;
    }

    // Result events: written by the agent, indexed by author. Build
    // (provider, jobEventId) pairs so we can cross-check `payment-completed`
    // feedback against an actual delivered result. Customers publish
    // `payment-completed` immediately on payment, before the result arrives -
    // an unmatched feedback means the provider never delivered (or never
    // existed at the time), so it must not count as a verified paid job.
    const deliveredJobsByProvider = new Map<string, Set<string>>();
    for (const ev of resultEvents) {
      if (!verifyEvent(ev)) {
        continue;
      }
      const agent = agentMap.get(ev.pubkey);
      if (!agent) {
        continue;
      }
      if (ev.created_at > agent.lastSeen) {
        agent.lastSeen = ev.created_at;
      }
      const jobEventId = ev.tags.find((tag) => tag[0] === 'e')?.[1];
      if (jobEventId) {
        let delivered = deliveredJobsByProvider.get(ev.pubkey);
        if (!delivered) {
          delivered = new Set();
          deliveredJobsByProvider.set(ev.pubkey, delivered);
        }
        delivered.add(jobEventId);
      }
    }

    // Feedback events: written by the *customer*, target agent in the `p` tag.
    // Tally rating counters and pick the newest `payment-completed` feedback
    // per agent as `lastPaidJobAt` / `lastPaidJobTx`, but only when the same
    // job has a matching kind:6xxx result from the provider.
    for (const ev of feedbackEvents) {
      if (!verifyEvent(ev)) {
        continue;
      }
      const targetPubkey = ev.tags.find((tag) => tag[0] === 'p')?.[1];
      if (!targetPubkey) {
        continue;
      }
      const agent = agentMap.get(targetPubkey);
      if (!agent) {
        continue;
      }
      if (ev.created_at > agent.lastSeen) {
        agent.lastSeen = ev.created_at;
      }

      const rating = ev.tags.find((tag) => tag[0] === 'rating')?.[1];
      if (rating === '1' || rating === '0') {
        agent.totalRatingCount = (agent.totalRatingCount ?? 0) + 1;
        if (rating === '1') {
          agent.positiveCount = (agent.positiveCount ?? 0) + 1;
        }
      }

      const status = ev.tags.find((tag) => tag[0] === 'status')?.[1];
      const txTag = ev.tags.find((tag) => tag[0] === 'tx');
      const txSignature = txTag?.[1];
      const jobEventId = ev.tags.find((tag) => tag[0] === 'e')?.[1];
      const hasDeliveredResult =
        jobEventId !== undefined &&
        deliveredJobsByProvider.get(targetPubkey)?.has(jobEventId) === true;
      if (
        status === 'payment-completed' &&
        typeof txSignature === 'string' &&
        txSignature &&
        hasDeliveredResult
      ) {
        if (!agent.lastPaidJobAt || ev.created_at > agent.lastPaidJobAt) {
          agent.lastPaidJobAt = ev.created_at;
          agent.lastPaidJobTx = txSignature;
        }
      }
    }

    agents.sort(compareAgentsByRank);

    return agents;
  }

  /**
   * Stream elisym agents progressively as relays deliver events.
   *
   * Two live subscriptions:
   *   - kind:31990 (capability cards) - emits `onAgent(agent)` for every new or
   *     updated `(pubkey, d-tag)`. The emitted Agent is the merged view across
   *     all surviving cards for that author.
   *   - kind:6100 (default-offset job results) tagged `t=elisym` since 30d ago -
   *     emits `onPaidJob(pubkey, ts)` for each delivered result. Custom-kind
   *     results (offset != 100) are not on this stream; they enter the final
   *     ranking via the post-EOSE enrichment pass.
   *
   * After capabilities EOSE, an enrichment pass runs in parallel to the live
   * subscriptions and produces a ranked snapshot via `onComplete`. The snapshot
   * is a clone, so further live updates do not mutate it.
   *
   * `closer.close()` tears down both subscriptions and aborts an in-flight
   * enrichment. If `opts.signal` is provided, aborting it does the same.
   */
  streamAgents(
    network: Network,
    opts: {
      onAgent: (agent: Agent) => void;
      onPaidJob?: (pubkey: string, ts: number) => void;
      onEose?: () => void;
      onComplete?: (agents: Agent[]) => void;
      signal?: AbortSignal;
    },
  ): SubCloser {
    const eventsByPubkey = new Map<string, Map<string, Event>>();
    const agentByPubkey = new Map<string, Agent>();
    const eoseSeen = { caps: false, results: false };
    let enrichmentStarted = false;
    const enrichmentAbort = new AbortController();

    const onExternalAbort = () => enrichmentAbort.abort();
    if (opts.signal) {
      if (opts.signal.aborted) {
        enrichmentAbort.abort();
      } else {
        opts.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const checkEose = () => {
      if (eoseSeen.caps && eoseSeen.results) {
        opts.onEose?.();
      }
    };

    const startEnrichment = () => {
      if (enrichmentStarted) {
        return;
      }
      enrichmentStarted = true;
      // Snapshot live agents so further `onAgent` updates do not race with
      // enrichment mutation.
      const snapshotAgents = Array.from(agentByPubkey.values()).map((agent) => ({ ...agent }));
      const snapshotMap = new Map(snapshotAgents.map((agent) => [agent.pubkey, agent]));
      void this.runEnrichment(snapshotAgents, snapshotMap, enrichmentAbort.signal).then(
        (sorted) => {
          if (enrichmentAbort.signal.aborted) {
            return;
          }
          opts.onComplete?.(sorted);
        },
        () => {
          /* enrichment errors are swallowed - stream stays usable until closed */
        },
      );
    };

    const capSub = this.pool.subscribe(
      { kinds: [KIND_APP_HANDLER], '#t': ['elisym'] },
      (event) => {
        const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
        let perDTag = eventsByPubkey.get(event.pubkey);
        const prev = perDTag?.get(dTag);
        if (prev && event.created_at <= prev.created_at) {
          return;
        }
        // Verify before trusting `event.pubkey`. An unsigned forged event with a
        // future `created_at` would otherwise displace a legitimate event from
        // the (pubkey, d-tag) slot.
        if (!verifyEvent(event)) {
          return;
        }

        // Distinguish tombstones (`{deleted: true}`) from invalid events.
        // `parseCapabilityEvent` returns null for both, but tombstones must be
        // stored in `perDTag` so the next `buildAgentsFromEvents` re-merge can
        // drop the corresponding card. Truthy check matches the validator in
        // `parseCapabilityEvent` (`if (candidate.deleted) return null`).
        if (!event.content) {
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(event.content);
        } catch {
          return;
        }
        const isTombstone =
          payload !== null &&
          typeof payload === 'object' &&
          Boolean((payload as { deleted?: unknown }).deleted);

        if (!isTombstone && !parseCapabilityEvent(event, network)) {
          return;
        }

        if (!perDTag) {
          perDTag = new Map();
          eventsByPubkey.set(event.pubkey, perDTag);
        }
        perDTag.set(dTag, event);

        const merged = buildAgentsFromEvents(Array.from(perDTag.values()), network).get(
          event.pubkey,
        );
        if (!merged) {
          // All cards for this author are now tombstoned. Drop the agent from
          // the snapshot so the post-EOSE enrichment pass excludes it. The
          // live UI will continue to show the agent until the next remount;
          // adding a removal callback is the proper fix.
          agentByPubkey.delete(event.pubkey);
          return;
        }
        agentByPubkey.set(event.pubkey, merged);
        opts.onAgent(merged);
      },
      {
        oneose: () => {
          eoseSeen.caps = true;
          startEnrichment();
          checkEose();
        },
      },
    );

    const activitySince = Math.floor(Date.now() / 1000) - RANKING_ACTIVITY_WINDOW_SECS;
    const resultsSub = this.pool.subscribe(
      { kinds: [KIND_JOB_RESULT], '#t': ['elisym'], since: activitySince },
      (event) => {
        // Verify signature before trusting `event.pubkey`. Without this, a
        // forged unsigned event would let an attacker bump any pubkey's
        // streaming `lastPaidJobAt` until enrichment overrides it. The
        // post-enrichment flush guards against bare-event spoofing once
        // `lastPaidJobTx` is set, but the pre-enrichment window would
        // otherwise be unprotected.
        if (!verifyEvent(event)) {
          return;
        }
        opts.onPaidJob?.(event.pubkey, event.created_at);
      },
      {
        oneose: () => {
          eoseSeen.results = true;
          checkEose();
        },
      },
    );

    return {
      close: (reason) => {
        capSub.close(reason);
        resultsSub.close(reason);
        enrichmentAbort.abort();
        opts.signal?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  /**
   * Publish a capability card (kind:31990) as a provider.
   * Solana address is validated for Base58 format only - full decode
   * validation (32-byte public key) happens at payment time.
   */
  async publishCapability(
    identity: ElisymIdentity,
    card: CapabilityCard,
    kinds: number[] = [KIND_JOB_REQUEST],
  ): Promise<string> {
    if (!card.payment?.address) {
      throw new Error(
        'Cannot publish capability without a payment address. Connect a wallet before publishing.',
      );
    }
    // Base58 charset + length check. Full validation (decode + 32 bytes) happens
    // at payment time via the @solana/kit `address()` helper - no Kit import here
    // to keep discovery browser-safe without a Solana peer dep at this layer.
    if (
      card.payment.chain === 'solana' &&
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(card.payment.address)
    ) {
      throw new Error(`Invalid Solana address format: ${card.payment.address}`);
    }
    if (card.name.length > LIMITS.MAX_AGENT_NAME_LENGTH) {
      throw new Error(
        `Agent name too long: ${card.name.length} chars (max ${LIMITS.MAX_AGENT_NAME_LENGTH}).`,
      );
    }
    if (card.description.length > LIMITS.MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `Description too long: ${card.description.length} chars (max ${LIMITS.MAX_DESCRIPTION_LENGTH}).`,
      );
    }
    if (card.capabilities.length > LIMITS.MAX_CAPABILITIES) {
      throw new Error(
        `Too many capabilities: ${card.capabilities.length} (max ${LIMITS.MAX_CAPABILITIES}).`,
      );
    }
    for (const cap of card.capabilities) {
      if (cap.length > LIMITS.MAX_CAPABILITY_LENGTH) {
        throw new Error(
          `Capability name too long: "${cap}" (${cap.length} chars, max ${LIMITS.MAX_CAPABILITY_LENGTH}).`,
        );
      }
    }

    const tags: string[][] = [
      ['d', toDTag(card.name)],
      ['t', 'elisym'],
      ...card.capabilities.map((c) => ['t', c]),
      ...kinds.map((k) => ['k', String(k)]),
    ];

    const event = finalizeEvent(
      {
        kind: KIND_APP_HANDLER,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify(card),
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
    return event.id;
  }

  /** Publish a Nostr profile (kind:0) as a provider. */
  async publishProfile(
    identity: ElisymIdentity,
    name: string,
    about: string,
    picture?: string,
    banner?: string,
  ): Promise<string> {
    if (name.length > LIMITS.MAX_AGENT_NAME_LENGTH) {
      throw new Error(
        `Profile name too long: ${name.length} chars (max ${LIMITS.MAX_AGENT_NAME_LENGTH}).`,
      );
    }
    if (about.length > LIMITS.MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `Profile about too long: ${about.length} chars (max ${LIMITS.MAX_DESCRIPTION_LENGTH}).`,
      );
    }
    const content: Record<string, string> = { name, about };
    if (picture) {
      content.picture = picture;
    }
    if (banner) {
      content.banner = banner;
    }

    const event = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(content),
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
    return event.id;
  }

  /**
   * Delete a capability by publishing a tombstone replacement.
   * Since kind:31990 is a parameterized replaceable event,
   * publishing a new event with the same `d` tag and `"deleted":true`
   * content replaces the old one on all relays.
   */
  async deleteCapability(identity: ElisymIdentity, capabilityName: string): Promise<string> {
    const dTag = toDTag(capabilityName);

    const event = finalizeEvent(
      {
        kind: KIND_APP_HANDLER,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', dTag],
          ['t', 'elisym'],
        ],
        content: JSON.stringify({ deleted: true }),
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
    return event.id;
  }
}
