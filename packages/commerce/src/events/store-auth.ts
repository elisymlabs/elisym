import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_STORE_AUTH } from '../constants';
import { HEX_PUBKEY_RE, nowSecs, tagValue, tagsNamed } from '../tags';

export type StoreAuthMode = 'self-host' | 'hosted' | 'revoked';

const STORE_AUTH_MODES: readonly string[] = ['self-host', 'hosted', 'revoked'];

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

/** Build the owner's authorization of a store key. The caller signs it with the OWNER key. */
export function buildStoreAuthEvent(input: StoreAuthInput): EventTemplate {
  if (!HEX_PUBKEY_RE.test(input.storePubkey)) {
    throw new Error('storePubkey must be 64 lowercase hex characters');
  }
  const tags: string[][] = [
    ['d', input.storePubkey],
    ['p', input.storePubkey],
    input.operator === undefined ? ['mode', input.mode] : ['mode', input.mode, input.operator],
  ];
  if (input.expiresAt !== undefined) {
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
  if (
    event.kind !== KIND_STORE_AUTH ||
    tagValue(tags, 'd') !== storePubkey ||
    !tagsNamed(tags, 'p').some((tag) => tag[1] === storePubkey)
  ) {
    return { status: 'malformed' };
  }
  const modeTag = tagsNamed(tags, 'mode')[0];
  const mode = modeTag?.[1];
  if (!isStoreAuthMode(mode)) {
    return { status: 'malformed' };
  }
  if (mode === 'revoked') {
    return { status: 'revoked' };
  }
  const expiration = tagValue(tags, 'expiration');
  if (expiration !== undefined) {
    if (!/^\d{1,12}$/.test(expiration)) {
      return { status: 'malformed' };
    }
    if (Number(expiration) <= now) {
      return { status: 'expired' };
    }
  }
  const operator = modeTag?.[2];
  return operator === undefined ? { status: 'active', mode } : { status: 'active', mode, operator };
}
