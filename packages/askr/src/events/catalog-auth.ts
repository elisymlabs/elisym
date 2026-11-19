import {
  HEX_PUBKEY_RE,
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
 * tag set as commerce's store authorization, but its own kind, so a catalog
 * key is never taken for a store key. The caller signs it with the OWNER key.
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

/** Whether the owner's 30497 authorizes `key` as a catalog key now, with full revocation, deletion and expiry semantics. */
export function isCatalogKey(
  events: readonly NostrEvent[],
  owner: string,
  key: string,
  now: number = nowSecs(),
): boolean {
  return resolveStoreAuth(events, owner, key, now, KIND_CATALOG_AUTH).status === 'active';
}

/**
 * Every catalog key the owner currently authorizes (spec 1.2): the `d` of
 * each of the owner's 30497 events is a candidate, checked with full
 * revocation, deletion and expiry semantics. The relay admission allowlist is
 * built from these keys.
 */
export function readCatalogAuthority(
  events: readonly NostrEvent[],
  owner: string,
  now: number = nowSecs(),
): Set<string> {
  const candidates = new Set<string>();
  for (const event of events) {
    // A malformed relay entry is skipped, never read: one bad entry must not
    // make the whole store's authority throw.
    if (!isEventShaped(event)) {
      continue;
    }
    if (event.pubkey === owner && event.kind === KIND_CATALOG_AUTH) {
      const key = tagValue(event.tags, 'd');
      if (key !== undefined && HEX_PUBKEY_RE.test(key)) {
        candidates.add(key);
      }
    }
  }
  return new Set([...candidates].filter((key) => isCatalogKey(events, owner, key, now)));
}

export interface StoreKeys {
  /** The key whose 30402 are the store's products, or none while it is not authorized. */
  productKey?: string;
  /** The key whose 30495 are the store's policies, or none. */
  policyKey?: string;
}

/**
 * Which keys a reader takes products and policies from (1.4): the config's
 * catalog key and its policy key, each only while it is an authorized
 * catalog key.
 */
export function resolveStoreKeys(
  config: Pick<StoreConfig, 'owner' | 'catalogKey' | 'policyKey'>,
  events: readonly NostrEvent[],
  now: number = nowSecs(),
): StoreKeys {
  const keys: StoreKeys = {};
  if (isCatalogKey(events, config.owner, config.catalogKey, now)) {
    keys.productKey = config.catalogKey;
  }
  if (isCatalogKey(events, config.owner, config.policyKey, now)) {
    keys.policyKey = config.policyKey;
  }
  return keys;
}
