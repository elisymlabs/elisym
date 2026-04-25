import { type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { nip19, finalizeEvent, verifyEvent, type Filter, type Event } from 'nostr-tools';
import {
  KIND_APP_HANDLER,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_REQUEST_BASE,
  KIND_JOB_RESULT_BASE,
  jobResultKind,
  DEFAULT_KIND_OFFSET,
  LIMITS,
} from '../constants';
import { verifyJobPaymentQuick } from '../payment/quick-verify';
import type { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type { Agent, CapabilityCard, Network } from '../types';

const RANKING_ACTIVITY_WINDOW_SECS = 30 * 24 * 60 * 60;
const RANKING_BUCKET_SIZE_SECS = 60;
const COLD_START_BUCKET = -Infinity;
// Cap how many `payment-completed` feedback events we'll on-chain verify per
// agent. Feedback is open Nostr - anyone can publish - so a malicious actor
// could spam fake `payment-completed` events to inflate verification cost or
// bury the legitimate one. We try the newest N candidates and stop at the
// first that verifies.
const MAX_PAID_CANDIDATES_PER_AGENT = 5;

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
 * Deduplicate events by (pubkey, d-tag) keeping only the newest,
 * then build an Agent map filtered by network.
 */
function buildAgentsFromEvents(events: Event[], network: Network): Map<string, Agent> {
  // Deduplicate by author + d-tag, keeping only the newest event
  const latestByDTag = new Map<string, Event>();
  for (const event of events) {
    if (!verifyEvent(event)) {
      continue;
    }
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const key = `${event.pubkey}:${dTag}`;
    const prev = latestByDTag.get(key);
    if (!prev || event.created_at > prev.created_at) {
      latestByDTag.set(key, event);
    }
  }

  // Intermediate structure: keep kTags per card so we can recompute
  // supportedKinds from only the surviving (deduplicated) entries.
  interface CardEntry {
    card: CapabilityCard;
    kTags: number[];
    createdAt: number;
  }
  interface AgentAccum {
    pubkey: string;
    npub: string;
    entries: CardEntry[];
    eventId: string;
    lastSeen: number;
  }

  const accumMap = new Map<string, AgentAccum>();

  for (const event of latestByDTag.values()) {
    try {
      if (!event.content) {
        continue;
      }
      const raw = JSON.parse(event.content);
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      if (typeof raw.name !== 'string' || !raw.name) {
        continue;
      }
      if (typeof raw.description !== 'string') {
        continue;
      }
      if (
        !Array.isArray(raw.capabilities) ||
        !raw.capabilities.every((c: unknown) => typeof c === 'string')
      ) {
        continue;
      }
      if (raw.deleted) {
        continue;
      }
      const card = raw as CapabilityCard & { deleted?: boolean };

      // Validate payment field types if present
      if (
        card.payment &&
        (typeof card.payment.chain !== 'string' ||
          typeof card.payment.network !== 'string' ||
          typeof card.payment.address !== 'string')
      ) {
        continue;
      }

      // Validate payment.job_price if present
      if (
        card.payment?.job_price !== null &&
        card.payment?.job_price !== undefined &&
        (!Number.isInteger(card.payment.job_price) || card.payment.job_price < 0)
      ) {
        continue;
      }

      const agentNetwork = card.payment?.network ?? 'devnet';
      if (agentNetwork !== network) {
        continue;
      }

      const kTags = event.tags
        .filter((t) => t[0] === 'k')
        .map((t) => parseInt(t[1] ?? '', 10))
        .filter((k) => !isNaN(k));

      const entry: CardEntry = { card, kTags, createdAt: event.created_at };

      const existing = accumMap.get(event.pubkey);
      if (existing) {
        // Deduplicate by card name - keep the newer version
        const dupIndex = existing.entries.findIndex((e) => e.card.name === card.name);
        if (dupIndex >= 0) {
          if (entry.createdAt >= existing.entries[dupIndex]!.createdAt) {
            existing.entries[dupIndex] = entry;
          }
        } else {
          existing.entries.push(entry);
        }
        if (event.created_at > existing.lastSeen) {
          existing.lastSeen = event.created_at;
          existing.eventId = event.id;
        }
      } else {
        accumMap.set(event.pubkey, {
          pubkey: event.pubkey,
          npub: nip19.npubEncode(event.pubkey),
          entries: [entry],
          eventId: event.id,
          lastSeen: event.created_at,
        });
      }
    } catch {
      // skip malformed events
    }
  }

  // Build final Agent map - recompute supportedKinds from surviving entries only
  const agentMap = new Map<string, Agent>();
  for (const [pubkey, acc] of accumMap) {
    const kindsSet = new Set<number>();
    for (const e of acc.entries) {
      for (const k of e.kTags) {
        kindsSet.add(k);
      }
    }
    const supportedKinds = [...kindsSet];
    agentMap.set(pubkey, {
      pubkey: acc.pubkey,
      npub: acc.npub,
      cards: acc.entries.map((e) => e.card),
      eventId: acc.eventId,
      supportedKinds,
      lastSeen: acc.lastSeen,
    });
  }

  return agentMap;
}

/** Pick the Solana payment address from an agent's capability cards. Returns first card with one. */
function pickSolanaAddress(agent: Agent): string | null {
  for (const card of agent.cards) {
    const addr = card.payment?.address;
    if (card.payment?.chain === 'solana' && typeof addr === 'string' && addr.length > 0) {
      return addr;
    }
  }
  return null;
}

interface PaidJobCandidate {
  txSignature: string;
  createdAt: number;
}

async function verifyNewestPaidCandidate(
  rpc: Rpc<SolanaRpcApi>,
  recipient: Address,
  candidatesNewestFirst: readonly PaidJobCandidate[],
): Promise<PaidJobCandidate | null> {
  const settled = await Promise.allSettled(
    candidatesNewestFirst.map((candidate) =>
      verifyJobPaymentQuick(rpc, candidate.txSignature, recipient),
    ),
  );
  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    if (entry?.status === 'fulfilled' && entry.value.verified) {
      return candidatesNewestFirst[i] ?? null;
    }
  }
  return null;
}

export class DiscoveryService {
  constructor(
    private pool: NostrPool,
    private defaultRpc?: Rpc<SolanaRpcApi>,
  ) {}

  /** Configure the Solana RPC used for on-chain payment verification in `fetchAgents`. */
  setRpc(rpc: Rpc<SolanaRpcApi> | undefined): void {
    this.defaultRpc = rpc;
  }

  /** Count elisym agents (kind:31990 with "elisym" tag). */
  async fetchAllAgentCount(): Promise<number> {
    const events = await this.pool.querySync({
      kinds: [KIND_APP_HANDLER],
      '#t': ['elisym'],
    } as Filter);

    const uniquePubkeys = new Set<string>();
    for (const event of events) {
      if (!verifyEvent(event)) {
        continue;
      }
      uniquePubkeys.add(event.pubkey);
    }
    return uniquePubkeys.size;
  }

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
   * Fetch elisym agents filtered by network, ranked by verified paid-job recency.
   *
   * Ranking algorithm:
   * 1. Bucket each agent into 1-minute slots by `lastPaidJobAt` (last on-chain
   *    verified payment). Cold-start agents (no verified paid job) go into a
   *    sentinel bucket below all populated buckets.
   * 2. Within a bucket, sort by positive review rate descending.
   * 3. Tiebreak by raw `lastPaidJobAt`, then `lastSeen` (NIP-89 freshness).
   *
   * On-chain verification uses {@link verifyJobPaymentQuick} - one-shot, cached.
   * If `rpc` is not configured, all agents fall through to cold-start and order
   * is determined by `lastSeen` only.
   */
  async fetchAgents(
    network: Network = 'devnet',
    limit?: number,
    rpcOverride?: Rpc<SolanaRpcApi>,
  ): Promise<Agent[]> {
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
    const agentPubkeys = Array.from(agentMap.keys());

    if (agentPubkeys.length === 0) {
      return agents;
    }

    const activitySince = Math.floor(Date.now() / 1000) - RANKING_ACTIVITY_WINDOW_SECS;
    // Derive result kinds from agents' supported request kinds (5xxx - 6xxx)
    const resultKinds = new Set<number>();
    for (const agent of agentMap.values()) {
      for (const k of agent.supportedKinds) {
        if (k >= KIND_JOB_REQUEST_BASE && k < KIND_JOB_RESULT_BASE) {
          resultKinds.add(KIND_JOB_RESULT_BASE + (k - KIND_JOB_REQUEST_BASE));
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

    // Result events: written by the agent, indexed by author.
    for (const ev of resultEvents) {
      if (!verifyEvent(ev)) {
        continue;
      }
      const agent = agentMap.get(ev.pubkey);
      if (agent && ev.created_at > agent.lastSeen) {
        agent.lastSeen = ev.created_at;
      }
    }

    // Feedback events: written by the *customer*, target agent in the `p` tag.
    // Tally rating counters and collect payment-completed candidates per agent
    // for on-chain verification. We keep the newest N per agent so that a
    // single fake `payment-completed` event can't shadow a legitimate one.
    const paidCandidates = new Map<string, PaidJobCandidate[]>();
    for (const ev of feedbackEvents) {
      if (!verifyEvent(ev)) {
        continue;
      }
      const targetPubkey = ev.tags.find((t) => t[0] === 'p')?.[1];
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

      const rating = ev.tags.find((t) => t[0] === 'rating')?.[1];
      if (rating === '1' || rating === '0') {
        agent.totalRatingCount = (agent.totalRatingCount ?? 0) + 1;
        if (rating === '1') {
          agent.positiveCount = (agent.positiveCount ?? 0) + 1;
        }
      }

      const status = ev.tags.find((t) => t[0] === 'status')?.[1];
      const txTag = ev.tags.find((t) => t[0] === 'tx');
      const txSignature = txTag?.[1];
      if (status === 'payment-completed' && typeof txSignature === 'string' && txSignature) {
        const list = paidCandidates.get(targetPubkey);
        const candidate: PaidJobCandidate = { txSignature, createdAt: ev.created_at };
        if (list) {
          list.push(candidate);
        } else {
          paidCandidates.set(targetPubkey, [candidate]);
        }
      }
    }

    const rpc = rpcOverride ?? this.defaultRpc;
    if (rpc && paidCandidates.size > 0) {
      const perAgent = Array.from(paidCandidates.entries()).map(([agentPubkey, list]) => {
        const agent = agentMap.get(agentPubkey);
        const recipient = agent ? pickSolanaAddress(agent) : null;
        if (!agent || !recipient) {
          return Promise.resolve();
        }
        const ordered = [...list]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, MAX_PAID_CANDIDATES_PER_AGENT);
        return verifyNewestPaidCandidate(rpc, recipient as Address, ordered).then((winner) => {
          if (winner) {
            agent.lastPaidJobAt = winner.createdAt;
            agent.lastPaidJobTx = winner.txSignature;
          }
        });
      });
      await Promise.all(perAgent);
    }

    agents.sort(compareAgentsByRank);

    return agents;
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
