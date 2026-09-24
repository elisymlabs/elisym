import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_STORE_AUTH } from '../constants';
import { HEX_PUBKEY_RE, expirationState, nowSecs, tagValue, tagsNamed } from '../tags';

export type StoreAuthMode = 'self-host' | 'hosted' | 'revoked';

const STORE_AUTH_MODES: readonly string[] = ['self-host', 'hosted', 'revoked'];
/** The reader takes at most 12 digits: past that it is milliseconds, not seconds. */
const MAX_EXPIRATION_SECS = 1e12;

function isStoreAuthMode(value: string | undefined): value is StoreAuthMode {
  return value !== undefined && STORE_AUTH_MODES.includes(value);
}

export interface StoreAuthInput {
  storePubkey: string;
  mode: Exclude<StoreAuthMode, 'revoked'>;
  /** Hosted mode: who runs the store, e.g. `elisym.network`. */
  operator?: string;
  /** Unix seconds (NIP-40). Short windows limit the damage of a stolen store key. */
  expiresAt?: number;
  createdAt?: number;
}

/** `<kind>:<owner>:<store>`, the address a NIP-09 deletion names to revoke an AUTH. */
export function storeAuthAddress(ownerPubkey: string, storePubkey: string): string {
  return `${KIND_STORE_AUTH}:${ownerPubkey}:${storePubkey}`;
}

/** Build the owner's authorization of a store key. The caller signs it with the OWNER key. */
export function buildStoreAuthEvent(input: StoreAuthInput): EventTemplate {
  if (!HEX_PUBKEY_RE.test(input.storePubkey)) {
    throw new Error('storePubkey must be 64 lowercase hex characters');
  }
  // A plain-JS caller could pass `revoked` or a typo: revoke with buildStoreRevocationEvent.
  if (input.mode !== 'self-host' && input.mode !== 'hosted') {
    throw new Error(`Invalid store mode: ${String(input.mode)}`);
  }
  const tags: string[][] = [
    ['d', input.storePubkey],
    ['p', input.storePubkey],
    input.operator === undefined ? ['mode', input.mode] : ['mode', input.mode, input.operator],
  ];
  if (input.expiresAt !== undefined) {
    // Whole seconds that `readStoreAuth` reads back: a millisecond timestamp
    // would sign an AUTH every reader calls malformed.
    if (
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= 0 ||
      input.expiresAt >= MAX_EXPIRATION_SECS
    ) {
      throw new Error('expiresAt must be a unix time in whole seconds');
    }
    tags.push(['expiration', String(input.expiresAt)]);
  }
  return { kind: KIND_STORE_AUTH, created_at: input.createdAt ?? nowSecs(), tags, content: '' };
}

/** Revoke a store key: the same address (`d`), `mode` revoked. Newest wins. */
export function buildStoreRevocationEvent(storePubkey: string, createdAt?: number): EventTemplate {
  if (!HEX_PUBKEY_RE.test(storePubkey)) {
    throw new Error('storePubkey must be 64 lowercase hex characters');
  }
  return {
    kind: KIND_STORE_AUTH,
    created_at: createdAt ?? nowSecs(),
    tags: [
      ['d', storePubkey],
      ['p', storePubkey],
      ['mode', 'revoked'],
    ],
    content: '',
  };
}

export type StoreAuthState =
  | { status: 'active'; mode: Exclude<StoreAuthMode, 'revoked'>; operator?: string }
  | { status: 'revoked' }
  | { status: 'expired' }
  | { status: 'malformed' };

/**
 * What an owner's newest AUTH event for `storePubkey` says at `now`. The caller
 * has checked the signature and the author, and picked the newest event for the
 * address. An event whose `d` or `p` names another store is malformed, never active.
 */
export function readStoreAuth(
  event: Pick<NostrEvent, 'kind' | 'tags'>,
  storePubkey: string,
  now: number = nowSecs(),
): StoreAuthState {
  const tags = event.tags;
  if (event.kind !== KIND_STORE_AUTH || tagValue(tags, 'd') !== storePubkey) {
    return { status: 'malformed' };
  }
  const modeTags = tagsNamed(tags, 'mode');
  // Two modes say two things: nothing reads them as one.
  if (modeTags.length !== 1) {
    return { status: 'malformed' };
  }
  const modeTag = modeTags[0];
  const mode = modeTag?.[1];
  if (!isStoreAuthMode(mode)) {
    return { status: 'malformed' };
  }
  // A revocation needs only its address and the mode (spec 2.4): taking the
  // store's key away must never hinge on a tag that only granting needs.
  if (mode === 'revoked') {
    return { status: 'revoked' };
  }
  if (!tagsNamed(tags, 'p').some((tag) => tag[1] === storePubkey)) {
    return { status: 'malformed' };
  }
  const expiration = expirationState(tags, now);
  if (expiration === 'malformed') {
    return { status: 'malformed' };
  }
  if (expiration === 'expired') {
    return { status: 'expired' };
  }
  const operator = modeTag?.[2];
  return operator === undefined ? { status: 'active', mode } : { status: 'active', mode, operator };
}
