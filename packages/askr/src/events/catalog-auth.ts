import {
  HEX_PUBKEY_RE,
  KIND_STORE_AUTH,
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  isEventShaped,
  nowSecs,
  resolveStoreAuth,
  tagValue,
} from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_CATALOG_AUTH } from '../constants';
import type { StoreConfig } from './config';

/** `paycore`: a 30490-authorized Pay Core store key S. `catalog`: a 30497-authorized Askr key K. */
export type CatalogKeyRole = 'paycore' | 'catalog';

export interface CatalogAuthInput {
  key: string;
  /** `hosted` for the server K, `self-host` for a merchant K. */
  mode: 'hosted' | 'self-host';
  /** Unix seconds (NIP-40). */
  expiresAt?: number;
  createdAt?: number;
}

/**
 * The owner's authorization of an Askr catalog key (kind 30497). The same
 * tag set as Pay Core's 30490, but its own kind, so Pay Core never takes a
 * catalog key for a store key. The caller signs it with the OWNER key.
 */
export function buildCatalogAuth(input: CatalogAuthInput): EventTemplate {
  const base = { storePubkey: input.key, mode: input.mode, kind: KIND_CATALOG_AUTH };
  return buildStoreAuthEvent({
    ...base,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  });
}

/** Revoke a catalog key. Newest wins; the caller signs with the OWNER key. */
export function buildCatalogRevocation(key: string, createdAt?: number): EventTemplate {
  return buildStoreRevocationEvent(key, createdAt, KIND_CATALOG_AUTH);
}

/** Whether `key` currently holds `role` for `owner`, with Pay Core's semantics exactly. */
export function hasRole(
  events: readonly NostrEvent[],
  owner: string,
  key: string,
  role: CatalogKeyRole,
  now: number = nowSecs(),
): boolean {
  const kind = role === 'catalog' ? KIND_CATALOG_AUTH : KIND_STORE_AUTH;
  return resolveStoreAuth(events, owner, key, now, kind).status === 'active';
}

/**
 * Every key the owner currently authorizes, with its roles (spec 1.2): the
 * `d` of each of the owner's 30490 and 30497 events is a candidate, checked
 * with full revocation, deletion and expiry semantics. A key can hold both
 * roles. The relay admission allowlist is built from the `catalog` keys.
 */
export function readCatalogAuthority(
  events: readonly NostrEvent[],
  owner: string,
  now: number = nowSecs(),
): Map<string, Set<CatalogKeyRole>> {
  const candidates = new Set<string>();
  for (const event of events) {
    // A malformed relay entry is skipped, never read: one bad entry must not
    // make the whole store's authority throw.
    if (!isEventShaped(event)) {
      continue;
    }
    if (
      event.pubkey === owner &&
      (event.kind === KIND_CATALOG_AUTH || event.kind === KIND_STORE_AUTH)
    ) {
      const key = tagValue(event.tags, 'd');
      if (key !== undefined && HEX_PUBKEY_RE.test(key)) {
        candidates.add(key);
      }
    }
  }
  const authority = new Map<string, Set<CatalogKeyRole>>();
  for (const key of candidates) {
    const roles = new Set<CatalogKeyRole>();
    if (resolveStoreAuth(events, owner, key, now, KIND_CATALOG_AUTH).status === 'active') {
      roles.add('catalog');
    }
    if (resolveStoreAuth(events, owner, key, now, KIND_STORE_AUTH).status === 'active') {
      roles.add('paycore');
    }
    if (roles.size > 0) {
      authority.set(key, roles);
    }
  }
  return authority;
}

export interface StoreKeys {
  /** The key whose 30402 are the store's products, or none while it is not authorized. */
  productKey?: string;
  productRole?: CatalogKeyRole;
  /** The key whose 30495 are the store's policies, or none. */
  policyKey?: string;
}

/**
 * Which keys a reader takes products and policies from (1.4): the config's
 * catalog key, if it holds the role its source needs (`paycore` for a Pay
 * Core source, `catalog` otherwise), and the config's policy key, if it holds
 * `catalog` (a Pay Core S never writes Askr policies).
 */
export function resolveStoreKeys(
  config: Pick<StoreConfig, 'owner' | 'source' | 'catalogKey' | 'policyKey'>,
  events: readonly NostrEvent[],
  now: number = nowSecs(),
): StoreKeys {
  const keys: StoreKeys = {};
  const neededRole: CatalogKeyRole = config.source.kind === 'paycore' ? 'paycore' : 'catalog';
  if (hasRole(events, config.owner, config.catalogKey, neededRole, now)) {
    keys.productKey = config.catalogKey;
    keys.productRole = neededRole;
  }
  if (hasRole(events, config.owner, config.policyKey, 'catalog', now)) {
    keys.policyKey = config.policyKey;
  }
  return keys;
}
