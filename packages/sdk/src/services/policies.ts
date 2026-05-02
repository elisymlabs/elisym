import { type Event, type Filter, finalizeEvent, nip19, verifyEvent } from 'nostr-tools';
import {
  KIND_LONG_FORM_ARTICLE,
  LIMITS,
  POLICY_D_TAG_PREFIX,
  POLICY_T_TAG,
  POLICY_TYPE_REGEX,
} from '../constants';
import type { ElisymIdentity } from '../primitives/identity';
import type { NostrPool } from '../transport/pool';
import type { AgentPolicy, PolicyInput } from '../types';

function dTagFor(type: string): string {
  return `${POLICY_D_TAG_PREFIX}${type}`;
}

function validatePolicyInput(input: PolicyInput): void {
  if (!POLICY_TYPE_REGEX.test(input.type)) {
    throw new Error(
      `Invalid policy type "${input.type}". Must be lowercase ASCII + hyphen, 1-${LIMITS.MAX_POLICY_TYPE_LENGTH} chars, no leading/trailing hyphen.`,
    );
  }
  if (input.version.length === 0 || input.version.length > LIMITS.MAX_POLICY_VERSION_LENGTH) {
    throw new Error(
      `Policy version must be 1-${LIMITS.MAX_POLICY_VERSION_LENGTH} chars (got ${input.version.length}).`,
    );
  }
  if (input.title.length === 0 || input.title.length > LIMITS.MAX_POLICY_TITLE_LENGTH) {
    throw new Error(
      `Policy title must be 1-${LIMITS.MAX_POLICY_TITLE_LENGTH} chars (got ${input.title.length}).`,
    );
  }
  if (input.summary !== undefined && input.summary.length > LIMITS.MAX_POLICY_SUMMARY_LENGTH) {
    throw new Error(
      `Policy summary too long: ${input.summary.length} chars (max ${LIMITS.MAX_POLICY_SUMMARY_LENGTH}).`,
    );
  }
  if (input.content.length === 0) {
    throw new Error('Policy content cannot be empty.');
  }
  if (input.content.length > LIMITS.MAX_POLICY_CONTENT_LENGTH) {
    throw new Error(
      `Policy content too long: ${input.content.length} chars (max ${LIMITS.MAX_POLICY_CONTENT_LENGTH}).`,
    );
  }
}

function parsePolicyEvent(event: Event): AgentPolicy | null {
  if (!verifyEvent(event)) {
    return null;
  }
  if (event.kind !== KIND_LONG_FORM_ARTICLE) {
    return null;
  }
  if (!event.content || event.content.length > LIMITS.MAX_POLICY_CONTENT_LENGTH) {
    return null;
  }

  const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1];
  if (!dTag || !dTag.startsWith(POLICY_D_TAG_PREFIX)) {
    return null;
  }

  const type = event.tags.find((tag) => tag[0] === 'policy_type')?.[1];
  if (!type || !POLICY_TYPE_REGEX.test(type)) {
    return null;
  }

  const version = event.tags.find((tag) => tag[0] === 'policy_version')?.[1];
  if (!version || version.length > LIMITS.MAX_POLICY_VERSION_LENGTH) {
    return null;
  }

  const title = event.tags.find((tag) => tag[0] === 'title')?.[1];
  if (!title || title.length > LIMITS.MAX_POLICY_TITLE_LENGTH) {
    return null;
  }

  const summaryTag = event.tags.find((tag) => tag[0] === 'summary')?.[1];
  const summary =
    summaryTag !== undefined && summaryTag.length <= LIMITS.MAX_POLICY_SUMMARY_LENGTH
      ? summaryTag
      : undefined;

  const naddr = nip19.naddrEncode({
    kind: KIND_LONG_FORM_ARTICLE,
    pubkey: event.pubkey,
    identifier: dTag,
    relays: [],
  });

  return {
    type,
    version,
    title,
    summary,
    content: event.content,
    naddr,
    dTag,
    publishedAt: event.created_at,
    eventId: event.id,
    authorPubkey: event.pubkey,
  };
}

export class PoliciesService {
  constructor(private pool: NostrPool) {}

  /**
   * Fetch all elisym policies published by `pubkey`. Verifies signatures,
   * dedupes by d-tag (latest `created_at` wins), and returns sorted by `type`
   * for deterministic UI rendering.
   *
   * Returns `[]` on empty result. Network errors propagate to the caller.
   */
  async fetchPolicies(pubkey: string): Promise<AgentPolicy[]> {
    const filter: Filter = {
      kinds: [KIND_LONG_FORM_ARTICLE],
      authors: [pubkey],
      '#t': [POLICY_T_TAG],
    };
    const events = await this.pool.querySync(filter);

    const latestByDTag = new Map<string, Event>();
    for (const event of events) {
      const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
      const prev = latestByDTag.get(dTag);
      if (!prev || event.created_at > prev.created_at) {
        latestByDTag.set(dTag, event);
      }
    }

    const policies: AgentPolicy[] = [];
    for (const event of latestByDTag.values()) {
      const parsed = parsePolicyEvent(event);
      if (parsed) {
        policies.push(parsed);
      }
    }
    policies.sort((a, b) => a.type.localeCompare(b.type));
    return policies;
  }

  /**
   * Publish a policy as a NIP-23 long-form article (kind 30023). Replaces any
   * existing policy of the same `type` for this pubkey via the addressable
   * `(kind, pubkey, d-tag)` slot.
   */
  async publishPolicy(
    identity: ElisymIdentity,
    input: PolicyInput,
  ): Promise<{ eventId: string; naddr: string }> {
    validatePolicyInput(input);

    const dTag = dTagFor(input.type);
    const tags: string[][] = [
      ['d', dTag],
      ['t', POLICY_T_TAG],
      ['title', input.title],
      ['policy_type', input.type],
      ['policy_version', input.version],
    ];
    if (input.summary) {
      tags.push(['summary', input.summary]);
    }

    const event = finalizeEvent(
      {
        kind: KIND_LONG_FORM_ARTICLE,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: input.content,
      },
      identity.secretKey,
    );

    await this.pool.publishAll(event);

    const naddr = nip19.naddrEncode({
      kind: KIND_LONG_FORM_ARTICLE,
      pubkey: event.pubkey,
      identifier: dTag,
      relays: [],
    });

    return { eventId: event.id, naddr };
  }

  /**
   * Tombstone a policy by publishing an empty replacement under the same
   * `(kind, pubkey, d-tag)` slot. Readers skip events with empty content.
   */
  async deletePolicy(identity: ElisymIdentity, type: string): Promise<string> {
    if (!POLICY_TYPE_REGEX.test(type)) {
      throw new Error(`Invalid policy type "${type}".`);
    }
    const dTag = dTagFor(type);
    const event = finalizeEvent(
      {
        kind: KIND_LONG_FORM_ARTICLE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', dTag],
          ['t', POLICY_T_TAG],
          ['policy_type', type],
        ],
        content: '',
      },
      identity.secretKey,
    );
    await this.pool.publishAll(event);
    return event.id;
  }
}
