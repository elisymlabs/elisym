import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { z } from 'zod';
import { KIND_STORE_PROFILE, LIMITS } from '../constants';
import { HEX_PUBKEY_RE, nowSecs, tagValue } from '../tags';

const ProfileContentSchema = z
  .object({
    name: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
    about: z.string().max(LIMITS.MAX_CONTENT_LENGTH).optional(),
    picture: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
    website: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
    nip05: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
  })
  .passthrough();

export interface StoreProfile {
  name?: string;
  about?: string;
  picture?: string;
  website?: string;
  nip05?: string;
  /** The owner pubkey the store points at (tag `owner`). One half of the two-way link. */
  ownerPubkey?: string;
}

export interface StoreProfileInput extends Omit<StoreProfile, 'ownerPubkey'> {
  ownerPubkey: string;
  createdAt?: number;
}

/** Build the store's kind 0. The caller signs it with the STORE key. */
export function buildStoreProfileEvent(input: StoreProfileInput): EventTemplate {
  if (!HEX_PUBKEY_RE.test(input.ownerPubkey)) {
    throw new Error('ownerPubkey must be 64 lowercase hex characters');
  }
  const content: Record<string, string> = {};
  for (const key of ['name', 'about', 'picture', 'website', 'nip05'] as const) {
    const value = input[key];
    if (value !== undefined) {
      content[key] = value;
    }
  }
  return {
    kind: KIND_STORE_PROFILE,
    created_at: input.createdAt ?? nowSecs(),
    tags: [['owner', input.ownerPubkey]],
    content: JSON.stringify(content),
  };
}

/** Read a store's kind 0, or `undefined` when its content is not a profile object. */
export function parseStoreProfile(
  event: Pick<NostrEvent, 'content' | 'tags'>,
): StoreProfile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return undefined;
  }
  const parsed = ProfileContentSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const owner = tagValue(event.tags, 'owner');
  const profile: StoreProfile = {};
  for (const key of ['name', 'about', 'picture', 'website', 'nip05'] as const) {
    const value = parsed.data[key];
    if (value !== undefined) {
      profile[key] = value;
    }
  }
  if (owner !== undefined && HEX_PUBKEY_RE.test(owner)) {
    profile.ownerPubkey = owner;
  }
  return profile;
}
