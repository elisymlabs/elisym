import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_STORE_PROFILE, LIMITS } from '../constants';
import { HEX_PUBKEY_RE, nowSecs, tagValue } from '../tags';

const PROFILE_FIELDS = ['name', 'about', 'picture', 'website', 'nip05'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Rendered as links or images: `https:` only, never a `javascript:` or `data:` URL. */
const URL_FIELDS: readonly ProfileField[] = ['picture', 'website'];

/** Longest value kept per field. A kind 0 is shared with other clients, so a field past it is dropped, not the profile. */
const PROFILE_FIELD_LIMITS: Record<ProfileField, number> = {
  name: LIMITS.MAX_TAG_VALUE_LENGTH,
  about: LIMITS.MAX_CONTENT_LENGTH,
  picture: LIMITS.MAX_TAG_VALUE_LENGTH,
  website: LIMITS.MAX_TAG_VALUE_LENGTH,
  nip05: LIMITS.MAX_TAG_VALUE_LENGTH,
};

/** What `parseStoreProfile` keeps, and so all that `buildStoreProfileEvent` will write. */
function isReadableField(key: ProfileField, value: string): boolean {
  return (
    value.length <= PROFILE_FIELD_LIMITS[key] &&
    (!URL_FIELDS.includes(key) || value.startsWith('https://'))
  );
}

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
  for (const key of PROFILE_FIELDS) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (!isReadableField(key, value)) {
      throw new Error(`Profile ${key} is too long or, for a link, not https`);
    }
    content[key] = value;
  }
  return {
    kind: KIND_STORE_PROFILE,
    created_at: input.createdAt ?? nowSecs(),
    tags: [['owner', input.ownerPubkey]],
    content: JSON.stringify(content),
  };
}

/**
 * Read a store's kind 0, or `undefined` when its content is not a JSON object.
 * A field of the wrong type or past its limit is dropped on its own: other
 * clients edit the same kind 0, and one odd field is not a missing profile.
 */
export function parseStoreProfile(
  event: Pick<NostrEvent, 'content' | 'tags'>,
): StoreProfile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const fields: Record<string, unknown> = { ...raw };
  const owner = tagValue(event.tags, 'owner');
  const profile: StoreProfile = {};
  for (const key of PROFILE_FIELDS) {
    const value = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (typeof value === 'string' && isReadableField(key, value)) {
      profile[key] = value;
    }
  }
  if (owner !== undefined && HEX_PUBKEY_RE.test(owner)) {
    profile.ownerPubkey = owner;
  }
  return profile;
}
