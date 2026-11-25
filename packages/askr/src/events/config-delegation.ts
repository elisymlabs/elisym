import {
  HEX_PUBKEY_RE,
  KIND_DELETION,
  MAX_FUTURE_SKEW_SECS,
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  isEventShaped,
  isGenuineEvent,
  newestDeletion,
  newestSigned,
  nowSecs,
  resolveStoreAuth,
  tagValue,
} from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  KIND_CONFIG_DELEGATION,
  MAX_CONFIG_DELEGATES,
} from '../constants';
import { type StoreConfig, parseConfig } from './config';

export interface ConfigDelegationInput {
  /** The delegate's hex public key. */
  key: string;
  /** Unix seconds (NIP-40). */
  expiresAt?: number;
  createdAt?: number;
}

/**
 * The owner's authorization of a config delegate (kind 30498): the delegate may
 * sign the store's config (30496 `d=askr`) and deletions of its own config
 * address, nothing else. The tag set of a catalog-key authorization, its own
 * kind. The caller signs it with the OWNER key.
 */
export function buildConfigDelegation(input: ConfigDelegationInput): EventTemplate {
  return buildStoreAuthEvent({
    storePubkey: input.key,
    mode: 'hosted',
    kind: KIND_CONFIG_DELEGATION,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  });
}

/** Revoke a config delegate. Newest wins; the caller signs with the OWNER key. */
export function buildConfigDelegationRevocation(key: string, createdAt?: number): EventTemplate {
  return buildStoreRevocationEvent(key, createdAt, KIND_CONFIG_DELEGATION);
}

/** `30496:<signer>:askr`: the config address a NIP-09 deletion names. */
export function configAddress(signer: string): string {
  return `${KIND_CONFIG}:${signer}:${CONFIG_D_TAG}`;
}

/**
 * The owner's active config delegates (1.3): every `d` of the owner's 30498
 * that is active now (revocation, deletion and expiry as for catalog keys),
 * the `MAX_CONFIG_DELEGATES` newest grants, newest first.
 */
export function readConfigDelegates(
  events: readonly NostrEvent[],
  owner: string,
  now: number = nowSecs(),
): string[] {
  const keys = new Set<string>();
  for (const event of events) {
    if (!isEventShaped(event) || event.pubkey !== owner || event.kind !== KIND_CONFIG_DELEGATION) {
      continue;
    }
    const key = tagValue(event.tags, 'd');
    if (key !== undefined && key !== owner && HEX_PUBKEY_RE.test(key)) {
      keys.add(key);
    }
  }
  const active: { key: string; grantedAt: number }[] = [];
  for (const key of keys) {
    if (resolveStoreAuth(events, owner, key, now, KIND_CONFIG_DELEGATION).status !== 'active') {
      continue;
    }
    const grant = newestSigned(events, KIND_CONFIG_DELEGATION, owner, now, key);
    if (grant !== undefined) {
      active.push({ key, grantedAt: grant.created_at });
    }
  }
  return active
    .sort((left, right) =>
      left.grantedAt === right.grantedAt
        ? compareText(left.key, right.key)
        : right.grantedAt - left.grantedAt,
    )
    .slice(0, MAX_CONFIG_DELEGATES)
    .map((entry) => entry.key);
}

export interface ConfigCandidate {
  event: NostrEvent;
  /** Parsed with the store's owner; undefined when the event does not parse. */
  config: StoreConfig | undefined;
}

export interface ConfigCandidateOptions {
  now: number;
  /** The reader's check of one event (shape and signature); defaults to `isGenuineEvent`. */
  isGenuine?: (event: NostrEvent) => boolean;
  /** How far past `now` an event may be dated; defaults to `MAX_FUTURE_SKEW_SECS`. */
  maxAheadSecs?: number;
}

/**
 * The store's config candidates (1.3): the owner's 30496 `d=askr` events and
 * those of its active delegates, newest first; ties: the owner first, then
 * delegates by key, then the lowest id. A delegate's config is dropped when a
 * deletion of its address by the delegate or the owner is as new. The owner's
 * own deletions are left to the reader, which keeps its own rule for them, so
 * without a delegate the list is the owner's configs exactly.
 */
export function configCandidates(
  events: readonly NostrEvent[],
  owner: string,
  options: ConfigCandidateOptions,
): ConfigCandidate[] {
  const { now } = options;
  const isGenuine = options.isGenuine ?? isGenuineEvent;
  const maxAhead = options.maxAheadSecs ?? MAX_FUTURE_SKEW_SECS;
  const delegates = new Set(readConfigDelegates(events, owner, now));
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (
      !isEventShaped(event) ||
      event.kind !== KIND_CONFIG ||
      tagValue(event.tags, 'd') !== CONFIG_D_TAG ||
      (event.pubkey !== owner && !delegates.has(event.pubkey)) ||
      event.created_at > now + maxAhead ||
      byId.has(event.id) ||
      !isGenuine(event)
    ) {
      continue;
    }
    byId.set(event.id, event);
  }
  const kept = [...byId.values()].filter(
    (event) => event.pubkey === owner || !isDelegateConfigDeleted(events, owner, event, now),
  );
  return kept
    .sort((left, right) => compareCandidates(left, right, owner))
    .map((event) => ({ event, config: parseConfig(event, { owner }) }));
}

function isDelegateConfigDeleted(
  events: readonly NostrEvent[],
  owner: string,
  event: NostrEvent,
  now: number,
): boolean {
  const address = configAddress(event.pubkey);
  return [event.pubkey, owner].some((author) => {
    const deletion = newestDeletion(events, address, author, now);
    return deletion !== undefined && deletion.created_at >= event.created_at;
  });
}

function compareCandidates(left: NostrEvent, right: NostrEvent, owner: string): number {
  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at;
  }
  if (left.pubkey !== right.pubkey) {
    if (left.pubkey === owner) {
      return -1;
    }
    if (right.pubkey === owner) {
      return 1;
    }
    return compareText(left.pubkey, right.pubkey);
  }
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** The owner's events every config reader fetches: its configs, delegations (30498) and deletions. */
export function storeConfigFilters(owner: string): Filter[] {
  return [
    { kinds: [KIND_CONFIG], authors: [owner], '#d': [CONFIG_D_TAG] },
    { kinds: [KIND_CONFIG_DELEGATION, KIND_DELETION], authors: [owner] },
  ];
}

/** The active delegates' configs and the deletions of their config addresses; none without delegates. */
export function delegateConfigFilters(delegates: readonly string[]): Filter[] {
  if (delegates.length === 0) {
    return [];
  }
  return [
    { kinds: [KIND_CONFIG], authors: [...delegates], '#d': [CONFIG_D_TAG] },
    {
      kinds: [KIND_DELETION],
      authors: [...delegates],
      '#a': delegates.map((delegate) => configAddress(delegate)),
    },
  ];
}
