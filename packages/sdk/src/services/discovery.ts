import { nip19, finalizeEvent, verifyEvent, type Filter, type Event } from 'nostr-tools';
import {
  KIND_APP_HANDLER,
  KIND_EXTERNAL_IDENTITIES,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  KIND_JOB_REQUEST_BASE,
  KIND_JOB_RESULT,
  KIND_JOB_RESULT_BASE,
  jobResultKind,
  DEFAULT_KIND_OFFSET,
  DEFAULTS,
  GIST_ID_REGEX,
  GITHUB_USERNAME_REGEX,
  LIMITS,
  TWEET_ID_REGEX,
  X_USERNAME_REGEX,
} from '../constants';
import { parseDelegationDescriptor } from '../delegation';
import type { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type {
  Agent,
  AgentExternalIdentity,
  CapabilityCard,
  ExternalIdentityClaimInput,
  ExternalIdentityClaimsResult,
  Network,
  SubCloser,
} from '../types';
import { normalizeNip05Identifier, splitNip05Identifier } from './identity-verify';
import type { MessagesService } from './messages';
import { requestJobIds, tallyReputation } from './reputation';

const RANKING_ACTIVITY_WINDOW_SECS = 30 * 24 * 60 * 60;
const RANKING_BUCKET_SIZE_SECS = 60;
const COLD_START_BUCKET = -Infinity;
/** Max clock skew for a capability event's `created_at`; further-future events are dropped. */
const MAX_FUTURE_SKEW_SECS = 300;

/**
 * Pagination-cursor floor: the elisym protocol did not exist before 2024, so
 * no real capability event can predate it. Without the floor a single
 * validly-signed event backdated to `created_at: 0` would drag the `until`
 * cursor to zero and silently end pagination for every consumer.
 */
const MIN_CURSOR_CREATED_AT = 1704067200; // 2024-01-01T00:00:00Z

/**
 * A validly-signed event can still carry an attacker-chosen future `created_at`.
 * Left unchecked it wins the newest-per-(pubkey, d-tag) dedup and inflates
 * `lastSeen`, so reject anything dated beyond a small clock-skew margin.
 */
function isWithinClockSkew(event: Event): boolean {
  return event.created_at <= Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECS;
}

/** Max length for a remote image URL before it is rejected outright. */
const MAX_IMAGE_URL_LEN = 2048;

/**
 * Provider-supplied avatar/banner URLs are rendered as `<img src>`, so a hostile
 * value turns every viewer into a tracking-pixel / SSRF probe (leaking their IP and,
 * via `Referer`, the pubkey they are inspecting). Accept only bounded `https:` URLs.
 */
function isSafeImageUrl(value: string): boolean {
  if (value.length > MAX_IMAGE_URL_LEN) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Sentinel signal that never aborts; lets `runEnrichment` accept an `AbortSignal` uniformly. */
const NEVER_ABORTED_SIGNAL: AbortSignal = new AbortController().signal;

// Payment-field formats enforced symmetrically: publishCapability rejects on
// write, parseCapabilityEvent rejects on read. A raw Nostr event (published
// outside the SDK) can carry arbitrary strings here, which would otherwise
// propagate into client state and downstream error messages.
// Base58 charset + length only - full decode validation happens at payment time.
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Lowercase token id (e.g. 'sol', 'usdc'). */
const PAYMENT_TOKEN_REGEX = /^[a-z0-9$._-]{1,32}$/;
/** Display symbol (e.g. 'SOL', 'USDC', '$LSM'). */
const PAYMENT_SYMBOL_REGEX = /^[A-Za-z0-9$._-]{1,32}$/;
/** SPL mint (base58) or EVM contract (0x-hex). */
const PAYMENT_MINT_REGEX = /^[0-9A-Za-z]{1,64}$/;

/**
 * Relay-side network isolation for capability queries (D2). Mainnet queries
 * add `'#n': ['mainnet']` - every mainnet card is post-launch and therefore
 * tagged, so the relay filter is complete and a mainnet client never even
 * downloads devnet cards. Devnet queries stay broad (legacy cards are
 * untagged); `parseCapabilityEvent` remains the authority on both networks.
 */
function mainnetTagFilter(network: Network): { '#n'?: string[] } {
  return network === 'mainnet' ? { '#n': ['mainnet'] } : {};
}

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
  if (!isWithinClockSkew(event)) {
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

  // Read-side mirror of the publish-side caps: the SDK never emits an
  // oversized card, so a violating event is hostile or foreign. Reject it at
  // the boundary - accepted cards are retained indefinitely in client state.
  if (
    card.name.length > LIMITS.MAX_AGENT_NAME_LENGTH ||
    card.description.length > LIMITS.MAX_DESCRIPTION_LENGTH ||
    card.capabilities.length > LIMITS.MAX_CAPABILITIES ||
    card.capabilities.some((capability) => capability.length > LIMITS.MAX_CAPABILITY_LENGTH)
  ) {
    return null;
  }

  // `image` is rendered as `<img src>` by consumers - a hostile value turns
  // every viewer into a tracking-pixel / SSRF probe. Clear (do NOT drop the
  // card, matching the `inputText` coercion below) so a bad image never
  // hides an otherwise valid agent.
  if (card.image !== undefined && (typeof card.image !== 'string' || !isSafeImageUrl(card.image))) {
    card.image = undefined;
  }

  if (
    card.payment &&
    (typeof card.payment.chain !== 'string' ||
      typeof card.payment.network !== 'string' ||
      typeof card.payment.address !== 'string')
  ) {
    return null;
  }

  // Optional token/symbol/mint must be strings when present: a non-string slips
  // through to display code (`payment.token.toUpperCase()`) and throws at render.
  if (
    card.payment &&
    ((card.payment.token !== undefined && typeof card.payment.token !== 'string') ||
      (card.payment.symbol !== undefined && typeof card.payment.symbol !== 'string') ||
      (card.payment.mint !== undefined && typeof card.payment.mint !== 'string'))
  ) {
    return null;
  }

  // Read-side mirror of publishCapability's payment format checks. Rejecting
  // here keeps hostile strings (prompt-injection payloads, ANSI escapes) out of
  // client state and every downstream error message.
  if (card.payment) {
    if (card.payment.chain === 'solana' && !SOLANA_ADDRESS_REGEX.test(card.payment.address)) {
      return null;
    }
    if (card.payment.token !== undefined && !PAYMENT_TOKEN_REGEX.test(card.payment.token)) {
      return null;
    }
    if (card.payment.symbol !== undefined && !PAYMENT_SYMBOL_REGEX.test(card.payment.symbol)) {
      return null;
    }
    if (card.payment.mint !== undefined && !PAYMENT_MINT_REGEX.test(card.payment.mint)) {
      return null;
    }
    // `decimals` is the one payment field that reaches arithmetic rather than
    // display-only text: consumers that cannot map the card to a registry
    // asset fall back to a self-describing one and render prices with this
    // value, so an out-of-range number shifts the decimal point of every
    // amount shown for this card. Same bound the payment-request schema
    // applies (`payment/schema.ts`); no real asset lives outside it.
    if (
      card.payment.decimals !== undefined &&
      (!Number.isInteger(card.payment.decimals) ||
        card.payment.decimals < 0 ||
        card.payment.decimals > 18)
    ) {
      return null;
    }
  }

  // Optional file-MIME hints must be bounded strings when present. This is
  // untrusted remote data; the cap (matching the loader's) keeps an unbounded
  // string out of client state. Clients gate on presence, not the value.
  if (
    (card.inputMime !== undefined &&
      (typeof card.inputMime !== 'string' || card.inputMime.length > 255)) ||
    (card.outputMime !== undefined &&
      (typeof card.outputMime !== 'string' || card.outputMime.length > 255))
  ) {
    return null;
  }

  // `inputText` is an enum, so coerce an unknown value to undefined (do NOT drop the
  // whole card like the strict MIME check above): forward-compat so a future value
  // never hides an agent from older clients. Clients gate on the known values only.
  if (card.inputText !== undefined && !['required', 'optional', 'none'].includes(card.inputText)) {
    card.inputText = undefined;
  }

  // `context` gates chat affordances (session-carrying sends), so only the strict
  // boolean `true` counts; anything else coerces to absent rather than dropping
  // the card - same forward-compat posture as `inputText`.
  if (card.context !== undefined && card.context !== true) {
    card.context = undefined;
  }

  // Delegation descriptor: validate (`.strip()`) and CLEAR on failure rather
  // than dropping the card - a malformed/forward-incompatible delegation must
  // never hide an otherwise valid agent. A cleared descriptor just means the
  // capability's delegation is unusable, not that the agent is gone.
  if (card.delegation !== undefined) {
    card.delegation = parseDelegationDescriptor(card.delegation) ?? undefined;
  }

  if (
    card.payment?.job_price !== null &&
    card.payment?.job_price !== undefined &&
    (!Number.isInteger(card.payment.job_price) || card.payment.job_price < 0)
  ) {
    return null;
  }

  const agentNetwork = card.payment?.network ?? 'devnet';
  // Tag/content cross-check (D2): the `n` tag exists for relay-side filtering
  // only - the signed card content stays the authority. A card whose tags
  // disagree with its content is hostile or corrupt; drop it. Untagged cards
  // (legacy) are exempt, and tombstones never reach this point (the `deleted`
  // early-return above) - they intentionally carry BOTH `n` values.
  const networkTags = event.tags
    .filter((tag) => tag[0] === 'n')
    .map((tag) => tag[1])
    .filter((value): value is string => typeof value === 'string');
  if (networkTags.length > 0 && !networkTags.includes(agentNetwork)) {
    return null;
  }
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
 * Parse a kind-10011 (NIP-39) event into external identity claims.
 *
 * Strict by design - the charset regexes are the URL-injection guard (handles
 * and proof ids are embedded into proof-fetch URLs):
 * - platform whitelist `github` / `twitter`; other platforms are ignored;
 * - `i` tags with more than 2 values are accepted (params 1-2 read, extras
 *   ignored - NIP-39 forward compatibility);
 * - at most `LIMITS.MAX_IDENTITY_TAGS` tags are scanned, counted AFTER the
 *   whitelist filter (a foreign multi-platform event with mastodon/telegram
 *   tags ahead of its github tag must not lose the claim to a scan cap);
 * - first valid claim per platform wins.
 */
export function parseExternalIdentityEvent(event: Event): AgentExternalIdentity[] {
  // Deliberately re-verifies even though enrichment already gated the event:
  // this is a public API and must stay safe for callers that skip that gate.
  if (!verifyEvent(event) || !isWithinClockSkew(event)) {
    return [];
  }
  const claims: AgentExternalIdentity[] = [];
  const seenPlatforms = new Set<string>();
  let whitelistedCount = 0;
  for (const tag of event.tags) {
    if (tag[0] !== 'i' || typeof tag[1] !== 'string') {
      continue;
    }
    const separatorIndex = tag[1].indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const platform = tag[1].slice(0, separatorIndex);
    const handle = tag[1].slice(separatorIndex + 1);
    if (platform !== 'github' && platform !== 'twitter') {
      continue;
    }
    whitelistedCount += 1;
    if (whitelistedCount > LIMITS.MAX_IDENTITY_TAGS) {
      break;
    }
    if (seenPlatforms.has(platform)) {
      continue;
    }
    const proofId = tag[2];
    if (typeof proofId !== 'string') {
      continue;
    }
    if (
      handle.length > LIMITS.MAX_IDENTITY_HANDLE_LENGTH ||
      proofId.length > LIMITS.MAX_IDENTITY_PROOF_ID_LENGTH
    ) {
      continue;
    }
    if (platform === 'github') {
      if (!GITHUB_USERNAME_REGEX.test(handle) || !GIST_ID_REGEX.test(proofId)) {
        continue;
      }
      seenPlatforms.add(platform);
      claims.push({
        platform: 'github',
        handle,
        proofUrl: `https://gist.github.com/${encodeURIComponent(handle)}/${encodeURIComponent(proofId)}`,
      });
    } else {
      if (!X_USERNAME_REGEX.test(handle) || !TWEET_ID_REGEX.test(proofId)) {
        continue;
      }
      seenPlatforms.add(platform);
      claims.push({
        platform: 'x',
        handle,
        proofUrl: `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(proofId)}`,
      });
    }
  }
  return claims;
}

/** Kind-0 profile fields after field-by-field guarded parsing. */
interface ParsedProfileMetadata {
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  /** Normalized NIP-05 identifier, present only when valid. */
  nip05?: string;
}

/**
 * Guarded parse of kind-0 content. Same skip-on-invalid posture per field as
 * the historical `enrichWithMetadata` inline parsing: kind-0 content is
 * unauthenticated remote data, so bad fields are dropped, never retained.
 */
function parseProfileMetadata(event: Event): ParsedProfileMetadata {
  const parsed: ParsedProfileMetadata = {};
  let meta: unknown;
  try {
    meta = JSON.parse(event.content);
  } catch {
    return parsed;
  }
  if (meta === null || typeof meta !== 'object') {
    return parsed;
  }
  const candidate = meta as Record<string, unknown>;
  if (typeof candidate.picture === 'string' && isSafeImageUrl(candidate.picture)) {
    parsed.picture = candidate.picture;
  }
  if (typeof candidate.banner === 'string' && isSafeImageUrl(candidate.banner)) {
    parsed.banner = candidate.banner;
  }
  // A blank name never beats the capability-derived one - skip it too.
  if (
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    candidate.name.length <= LIMITS.MAX_AGENT_NAME_LENGTH
  ) {
    parsed.name = candidate.name;
  }
  if (
    typeof candidate.about === 'string' &&
    candidate.about.length <= LIMITS.MAX_DESCRIPTION_LENGTH
  ) {
    parsed.about = candidate.about;
  }
  if (typeof candidate.nip05 === 'string') {
    const identifier = normalizeNip05Identifier(candidate.nip05);
    if (identifier !== null) {
      parsed.nip05 = identifier;
    }
  }
  return parsed;
}

/** The website claim derived from a valid kind-0 `nip05` identifier. */
function websiteClaimFromNip05(identifier: string): AgentExternalIdentity {
  const { domain } = splitNip05Identifier(identifier);
  return { platform: 'website', handle: identifier, proofUrl: `https://${domain}` };
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
    if (!verifyEvent(event) || !isWithinClockSkew(event)) {
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
  /**
   * `messages` is optional so standalone `new DiscoveryService(pool)`
   * construction keeps working; when present (the `ElisymClient` wiring),
   * a successful capability publish also announces the agent's DM inbox
   * relays (kind 10050) through it.
   */
  constructor(
    private pool: NostrPool,
    private messages?: MessagesService,
  ) {}

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
      ...mainnetTagFilter(network),
      limit,
    };
    if (until !== undefined) {
      filter.until = until;
    }

    const events = await this.pool.querySync(filter);
    const rawEventCount = events.length;

    // Compute the cursor before capability-schema filtering (so forward-compat
    // events still advance pagination), but only from events that pass the
    // same signature + clock-skew gate as every other read path, plus the
    // protocol-epoch floor: unverified or backdated input must not steer
    // `until` and silently end pagination. nostr-tools memoizes verifyEvent
    // per event object, so the re-check in buildAgentsFromEvents is free.
    let oldestCreatedAt: number | null = null;
    for (const event of events) {
      if (!verifyEvent(event) || !isWithinClockSkew(event)) {
        continue;
      }
      if (event.created_at < MIN_CURSOR_CREATED_AT) {
        continue;
      }
      if (oldestCreatedAt === null || event.created_at < oldestCreatedAt) {
        oldestCreatedAt = event.created_at;
      }
    }

    const agentMap = buildAgentsFromEvents(events, network);

    const agents = Array.from(agentMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);

    return { agents, oldestCreatedAt, rawEventCount };
  }

  /**
   * Enrich agents with kind:0 metadata (name, picture, about, nip05) and
   * kind-10011 external identity claims. Mutates in place and returns the
   * same array. Claims ride this one batched relay query - no HTTP proof
   * fetches ever happen here (cheapness contract).
   */
  async enrichWithMetadata(agents: Agent[]): Promise<Agent[]> {
    const pubkeys = agents.map((a) => a.pubkey);
    if (pubkeys.length === 0) {
      return agents;
    }

    // Both kinds are replaceable, but the two-kind query doubles the
    // per-filter worst case (500 events at BATCH_SIZE 250) - halve the batch
    // so relays with lower server-side caps do not silently truncate.
    const metaEvents = await this.pool.queryBatched(
      { kinds: [0, KIND_EXTERNAL_IDENTITIES] } as Omit<Filter, 'authors'>,
      pubkeys,
      Math.floor(DEFAULTS.BATCH_SIZE / 2),
    );
    // Newest-wins split per (pubkey, kind): kind 0 routes to the profile
    // parser and kind 10011 to the identity parser. Keying by pubkey alone
    // would drop whichever of the two kinds is older.
    // Clock-skew gate matches every other newest-wins pick in this file: a
    // validly-signed event with a far-future created_at would otherwise pin
    // the profile against all later legitimate updates.
    const latestPerKind = new Map<string, Event>();
    for (const ev of metaEvents) {
      if (!verifyEvent(ev) || !isWithinClockSkew(ev)) {
        continue;
      }
      const key = `${ev.pubkey}:${ev.kind}`;
      const prev = latestPerKind.get(key);
      if (!prev || ev.created_at > prev.created_at) {
        latestPerKind.set(key, ev);
      }
    }
    for (const agent of agents) {
      const metaEvent = latestPerKind.get(`${agent.pubkey}:0`);
      const identityEvent = latestPerKind.get(`${agent.pubkey}:${KIND_EXTERNAL_IDENTITIES}`);
      let websiteClaim: AgentExternalIdentity | undefined;
      if (metaEvent) {
        const profile = parseProfileMetadata(metaEvent);
        if (profile.picture !== undefined) {
          agent.picture = profile.picture;
        }
        if (profile.banner !== undefined) {
          agent.banner = profile.banner;
        }
        if (profile.name !== undefined) {
          agent.name = profile.name;
        }
        if (profile.about !== undefined) {
          agent.about = profile.about;
        }
        if (profile.nip05 !== undefined) {
          websiteClaim = websiteClaimFromNip05(profile.nip05);
        }
      }
      // Contract: `identities` is the per-pass snapshot of the claims derivable
      // from the metadata events THIS query returned. Assign only when at least
      // one of the two events came back; a TOTAL miss (both absent - timeout, or
      // relays not holding either event) leaves the key undefined so spread-
      // merging consumers ({...cached, ...fresh}) keep prior claims, matching how
      // the kind-0 fields above omit keys they could not populate. A retraction
      // still ships an event (empty-tag kind 10011, kind 0 without nip05), so it
      // produces a DEFINED empty set and correctly drops stale claims.
      //
      // Trade-off: the claim set spans two events but lands in one array, so a
      // PARTIAL miss (one kind returns, the other times out) snapshots only the
      // returned kind and can transiently drop the other kind's cached claims
      // until a pass that returns both. This is rare (both kinds ride one filter
      // to the same relays, so a relay holding the author usually returns both)
      // and self-heals; splitting the public claim set per source to preserve it
      // is not worth the API surface for an unverified display hint.
      if (metaEvent || identityEvent) {
        const claims = identityEvent ? parseExternalIdentityEvent(identityEvent) : [];
        if (websiteClaim) {
          claims.push(websiteClaim);
        }
        agent.identities = claims;
      }
    }
    return agents;
  }

  /**
   * Fetch one agent's external identity claims (kind 10011 + kind-0 nip05)
   * with a single direct author-scoped relay query. Deliberately NOT built on
   * `fetchAgents`/`fetchAgent`: those are card-gated, so a pubkey with no
   * surviving kind-31990 cards (customer agents, a provider before its first
   * start) would appear claim-less. Also returns the newest kind-0 profile
   * fields so a CLI kind-0 republish can carry over picture/banner without a
   * second fetch.
   */
  async fetchExternalIdentityClaims(pubkey: string): Promise<ExternalIdentityClaimsResult> {
    const events = await this.pool.queryBatched(
      { kinds: [0, KIND_EXTERNAL_IDENTITIES] } as Omit<Filter, 'authors'>,
      [pubkey],
    );
    const latestPerKind = new Map<number, Event>();
    for (const ev of events) {
      // The query is author-scoped; verify authorship anyway.
      if (ev.pubkey !== pubkey) {
        continue;
      }
      if (!verifyEvent(ev) || !isWithinClockSkew(ev)) {
        continue;
      }
      const prev = latestPerKind.get(ev.kind);
      if (!prev || ev.created_at > prev.created_at) {
        latestPerKind.set(ev.kind, ev);
      }
    }
    const metaEvent = latestPerKind.get(0);
    const identityEvent = latestPerKind.get(KIND_EXTERNAL_IDENTITIES);
    const profile: ParsedProfileMetadata = metaEvent ? parseProfileMetadata(metaEvent) : {};
    const identities = identityEvent ? parseExternalIdentityEvent(identityEvent) : [];
    if (profile.nip05 !== undefined) {
      identities.push(websiteClaimFromNip05(profile.nip05));
    }
    return { identities, profile };
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
      ...mainnetTagFilter(network),
    };
    if (limit !== undefined) {
      filter.limit = limit;
    }
    const events = await this.pool.querySync(filter);

    const agentMap = buildAgentsFromEvents(events, network);
    const agents = Array.from(agentMap.values());

    return this.runEnrichment(agents, agentMap, NEVER_ABORTED_SIGNAL, network);
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
      ...mainnetTagFilter(network),
      authors: [pubkey],
    });

    const agentMap = buildAgentsFromEvents(events, network);
    if (agentMap.size === 0) {
      return null;
    }
    const agents = Array.from(agentMap.values());
    await this.runEnrichment(agents, agentMap, NEVER_ABORTED_SIGNAL, network);
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
    network: Network,
  ): Promise<Agent[]> {
    const agentPubkeys = Array.from(agentMap.keys());
    if (agentPubkeys.length === 0) {
      return agents;
    }

    const activitySince = Math.floor(Date.now() / 1000) - RANKING_ACTIVITY_WINDOW_SECS;
    // Derive result kinds from agents' supported request kinds (5xxx - 6xxx)
    const resultKinds = new Set<number>();
    // Request kinds the anchor fetch below will filter on. A request's kind is one the
    // provider supports, and every in-scope provider's supportedKinds are collected
    // here, so this covers every attributable request while giving the relay an explicit
    // `kinds` (some relays reject an ids-only filter).
    const requestKinds = new Set<number>();
    for (const agent of agentMap.values()) {
      for (const supportedKind of agent.supportedKinds) {
        if (supportedKind >= KIND_JOB_REQUEST_BASE && supportedKind < KIND_JOB_RESULT_BASE) {
          resultKinds.add(KIND_JOB_RESULT_BASE + (supportedKind - KIND_JOB_REQUEST_BASE));
          requestKinds.add(supportedKind);
        }
      }
    }
    resultKinds.add(jobResultKind(DEFAULT_KIND_OFFSET));
    requestKinds.add(KIND_JOB_REQUEST);

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

    // Fetch the job requests that authorship is anchored to. Seeded by the union
    // of both feedback streams' `e`-tags (ratings + payment-completed) so J is
    // present for paid-but-unrated jobs. No `since` - the id set bounds it, and
    // a request can predate the 30-day feedback window. This is a Nostr relay
    // query, not a Solana RPC call.
    const jobIds = requestJobIds(feedbackEvents);
    const requestEvents =
      jobIds.length > 0 ? await this.pool.queryByIds({ kinds: [...requestKinds] }, jobIds) : [];

    if (signal.aborted) {
      return agents;
    }

    const reputation = tallyReputation({
      agentPubkeys,
      resultEvents,
      feedbackEvents,
      requestEvents,
      network,
    });

    for (const agent of agents) {
      const rep = reputation.get(agent.pubkey);
      if (!rep) {
        continue;
      }
      if (rep.lastActivityAt !== undefined && rep.lastActivityAt > agent.lastSeen) {
        agent.lastSeen = rep.lastActivityAt;
      }
      // `compareAgentsByRank` reads only the Nostr-verified tier; the unverified
      // tier is display-only.
      agent.totalRatingCount = rep.nostrVerified.total;
      agent.positiveCount = rep.nostrVerified.positive;
      agent.unverifiedRatingCount = rep.unverified.total;
      agent.unverifiedPositiveCount = rep.unverified.positive;
      if (rep.lastPaidJobAt !== undefined) {
        agent.lastPaidJobAt = rep.lastPaidJobAt;
        agent.lastPaidJobTx = rep.lastPaidJobTx;
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
      void this.runEnrichment(snapshotAgents, snapshotMap, enrichmentAbort.signal, network).then(
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
      { kinds: [KIND_APP_HANDLER], '#t': ['elisym'], ...mainnetTagFilter(network) },
      (event) => {
        const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
        let perDTag = eventsByPubkey.get(event.pubkey);
        const prev = perDTag?.get(dTag);
        if (prev && event.created_at <= prev.created_at) {
          return;
        }
        // Verify before trusting `event.pubkey`, and reject a far-future
        // `created_at`: a validly-signed but future-dated event would otherwise
        // displace a legitimate event from the (pubkey, d-tag) slot. The
        // `perDTag.set` below runs only after both checks pass, so a rejected
        // event never evicts the incumbent.
        if (!verifyEvent(event) || !isWithinClockSkew(event)) {
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
        // Verify signature before trusting `event.pubkey`, and reject a far-future
        // `created_at`: a self-signed result event could otherwise pin the provider's
        // pre-enrichment streaming `lastPaidJobAt` to the top of the ranking. The
        // post-enrichment flush guards spoofing once `lastPaidJobTx` is set, but the
        // pre-enrichment window would otherwise be unprotected.
        if (!verifyEvent(event) || !isWithinClockSkew(event)) {
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
    if (card.payment.chain === 'solana' && !SOLANA_ADDRESS_REGEX.test(card.payment.address)) {
      throw new Error(`Invalid Solana address format: ${card.payment.address}`);
    }
    // Write-side mirror of parseCapabilityEvent's payment format checks:
    // readers reject violating cards, so publishing one would silently ship a
    // card no SDK client ever displays.
    if (card.payment.token !== undefined && !PAYMENT_TOKEN_REGEX.test(card.payment.token)) {
      throw new Error(`Invalid payment token id: ${card.payment.token}`);
    }
    if (card.payment.symbol !== undefined && !PAYMENT_SYMBOL_REGEX.test(card.payment.symbol)) {
      throw new Error(`Invalid payment symbol: ${card.payment.symbol}`);
    }
    if (card.payment.mint !== undefined && !PAYMENT_MINT_REGEX.test(card.payment.mint)) {
      throw new Error(`Invalid payment mint: ${card.payment.mint}`);
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
    // Write-side mirror of the parse-side guard: readers clear non-https
    // images, so publishing one would silently ship a card with no image.
    if (card.image !== undefined && !isSafeImageUrl(card.image)) {
      throw new Error('Capability image must be a bounded https: URL.');
    }
    // Write-side mirror of the delegation coercion: readers clear a malformed
    // descriptor, so publishing one would silently ship an unusable delegation.
    // Fail loud instead - a bad descriptor is an operator/host bug.
    if (card.delegation !== undefined && parseDelegationDescriptor(card.delegation) === null) {
      throw new Error(
        'Capability delegation descriptor is malformed (mechanism/delegate_pubkey/cap).',
      );
    }

    const tags: string[][] = [
      ['d', toDTag(card.name)],
      ['t', 'elisym'],
      // Single-letter network tag (D2): NIP-01 only mandates indexing of
      // single-letter tags, so `#n` is relay-filterable everywhere. The signed
      // card content stays the authoritative copy.
      ['n', card.payment.network ?? 'devnet'],
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

    // "Agent is announced" should imply "agent is reachable via DM from any
    // NIP-17 client". Best-effort: the DM inbox hint must never fail the
    // announce - the capability card is the deliverable, the 10050 is not.
    // Default-mode guards inside publishInboxRelays (debounce + ownership)
    // keep the per-skill announce loop from republishing or clobbering an
    // operator-managed relay list.
    if (this.messages) {
      try {
        await this.messages.publishInboxRelays(identity);
      } catch {
        // Swallowed by design - see above.
      }
    }
    return event.id;
  }

  /**
   * Publish external identity claims (kind 10011, NIP-39) as a provider.
   * Normal-replaceable: every publish overwrites the previous claim set, and
   * an EMPTY claim list is published too - that is how an unlink propagates.
   *
   * Write-side mirror of `parseExternalIdentityEvent` (same shared regexes):
   * consumers silently drop violating tags, so a hand-edited bad handle must
   * fail loud here, not ship a claim no SDK client ever surfaces.
   */
  async publishExternalIdentities(
    identity: ElisymIdentity,
    claims: ExternalIdentityClaimInput[],
  ): Promise<string> {
    if (claims.length > LIMITS.MAX_IDENTITY_TAGS) {
      throw new Error(
        `Too many identity claims: ${claims.length} (max ${LIMITS.MAX_IDENTITY_TAGS}).`,
      );
    }
    const seenPlatforms = new Set<string>();
    const tags: string[][] = [];
    for (const claim of claims) {
      if (seenPlatforms.has(claim.platform)) {
        throw new Error(
          `Duplicate identity claim for platform "${claim.platform}": readers keep the first tag per platform only.`,
        );
      }
      switch (claim.platform) {
        case 'github':
          if (!GITHUB_USERNAME_REGEX.test(claim.handle)) {
            throw new Error(`Invalid GitHub username: ${claim.handle}`);
          }
          if (!GIST_ID_REGEX.test(claim.proofId)) {
            throw new Error(`Invalid GitHub gist id: ${claim.proofId}`);
          }
          tags.push(['i', `github:${claim.handle}`, claim.proofId]);
          break;
        case 'x':
          if (!X_USERNAME_REGEX.test(claim.handle)) {
            throw new Error(`Invalid X username: ${claim.handle}`);
          }
          if (!TWEET_ID_REGEX.test(claim.proofId)) {
            throw new Error(`Invalid tweet id: ${claim.proofId}`);
          }
          // On-wire platform name stays `twitter` (NIP-39 interop).
          tags.push(['i', `twitter:${claim.handle}`, claim.proofId]);
          break;
        default:
          throw new Error(
            `Unsupported identity platform: ${String((claim as { platform: unknown }).platform)}`,
          );
      }
      seenPlatforms.add(claim.platform);
    }

    const event = finalizeEvent(
      {
        kind: KIND_EXTERNAL_IDENTITIES,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
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
    nip05?: string,
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
    // Same rule readers enforce in enrichWithMetadata: an unsafe URL would
    // never render for any SDK consumer, so fail the publish loudly instead
    // of broadcasting a profile that silently drops its images.
    if (picture && !isSafeImageUrl(picture)) {
      throw new Error('Profile picture must be a bounded https: URL.');
    }
    if (banner && !isSafeImageUrl(banner)) {
      throw new Error('Profile banner must be a bounded https: URL.');
    }
    // Same loud-on-write posture as the image fields: readers drop an invalid
    // nip05, so publishing one would silently ship a dead website claim. The
    // bare-domain form is normalized to the `_@domain` NIP-05 root identifier.
    let normalizedNip05: string | undefined;
    if (nip05 !== undefined) {
      const identifier = normalizeNip05Identifier(nip05);
      if (identifier === null) {
        throw new Error(
          `Invalid nip05 identifier: ${nip05}. Expected name@domain or a bare domain with ASCII hostname labels (no IP literals).`,
        );
      }
      normalizedNip05 = identifier;
    }
    const content: Record<string, string> = { name, about };
    if (picture) {
      content.picture = picture;
    }
    if (banner) {
      content.banner = banner;
    }
    if (normalizedNip05 !== undefined) {
      content.nip05 = normalizedNip05;
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
          // Tombstones carry BOTH network tags (D2): the `d` address is
          // network-agnostic and filter tag values are OR-matched, so one
          // tombstone suppresses the card under either network's `#n` query.
          // An untagged tombstone would never match the mainnet filter and a
          // stale tagged card on another relay could resurrect the agent.
          ['n', 'devnet'],
          ['n', 'mainnet'],
        ],
        content: JSON.stringify({ deleted: true }),
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);
    return event.id;
  }
}
