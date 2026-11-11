import {
  KIND_STORE_AUTH,
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
  nowSecs,
  resolveStoreAuth,
} from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_CATALOG_AUTH } from '../constants';
import type { StoreConfig } from './config';

/** `paycore`: a 30490-authorized Pay Core store key S. `catalog`: a 30497-authorized ComCore key K. */
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
 * The owner's authorization of a ComCore catalog key (kind 30497). The same
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

/**
 * The role `key` currently holds for `owner`, from the events a reader holds
 * (30490, 30497 and kind 5 of the owner), or `undefined` when it holds none.
 * Pay Core's semantics exactly: newest wins, revocations and NIP-09 deletions
 * stand, expiry lapses, a malformed newest word fails closed.
 */
export function catalogKeyRole(
  events: readonly NostrEvent[],
  owner: string,
  key: string,
  now: number = nowSecs(),
): CatalogKeyRole | undefined {
  if (resolveStoreAuth(events, owner, key, now, KIND_CATALOG_AUTH).status === 'active') {
    return 'catalog';
  }
  if (resolveStoreAuth(events, owner, key, now, KIND_STORE_AUTH).status === 'active') {
    return 'paycore';
  }
  return undefined;
}

/** Every candidate key that currently holds a role, with that role. */
export function readCatalogAuthority(
  events: readonly NostrEvent[],
  owner: string,
  candidates: readonly string[],
  now: number = nowSecs(),
): Map<string, CatalogKeyRole> {
  const authority = new Map<string, CatalogKeyRole>();
  for (const key of new Set(candidates)) {
    const role = catalogKeyRole(events, owner, key, now);
    if (role !== undefined) {
      authority.set(key, role);
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
 * `catalog` (a Pay Core S never writes ComCore policies).
 */
export function resolveStoreKeys(
  config: Pick<StoreConfig, 'owner' | 'source' | 'catalogKey' | 'policyKey'>,
  events: readonly NostrEvent[],
  now: number = nowSecs(),
): StoreKeys {
  const authority = readCatalogAuthority(
    events,
    config.owner,
    [config.catalogKey, config.policyKey],
    now,
  );
  const keys: StoreKeys = {};
  const productRole = authority.get(config.catalogKey);
  const neededRole: CatalogKeyRole = config.source.kind === 'paycore' ? 'paycore' : 'catalog';
  if (productRole === neededRole) {
    keys.productKey = config.catalogKey;
    keys.productRole = productRole;
  }
  if (authority.get(config.policyKey) === 'catalog') {
    keys.policyKey = config.policyKey;
  }
  return keys;
}
