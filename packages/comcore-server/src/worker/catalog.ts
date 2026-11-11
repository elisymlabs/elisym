import {
  COMCORE_RELAYS,
  CONFIG_D_TAG,
  type CatalogItem,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  KIND_POLICY,
  type Policy,
  type StoreConfig,
  decryptPrivateConfig,
  parseCatalogItem,
  parseConfig,
  parsePolicy,
  resolveStoreKeys,
} from '@elisym/comcore';
import { StoreCatalog } from '@elisym/comcore-agent';
import {
  KIND_DELETION,
  KIND_PRODUCT,
  KIND_STORE_AUTH,
  NO_FUTURE_LIMIT,
  newestDeletion,
  newestSigned,
} from '@elisym/commerce';
import { DEFAULT_RELAYS } from '@elisym/commerce/buyer';
import type { Filter, NostrEvent } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';

const AUTHORITY_KINDS: readonly number[] = [KIND_CATALOG_AUTH, KIND_STORE_AUTH, KIND_DELETION];

/** The owner's events a store needs first: its config, authority (30497 and Pay Core's 30490) and deletions. */
export function ownerFilters(owner: string): Filter[] {
  return [{ kinds: [KIND_CONFIG, ...AUTHORITY_KINDS], authors: [owner] }];
}

/**
 * Relays a `paycore` source is also read from (2.4): commerce's
 * `DEFAULT_RELAYS`, where Pay Core publishes, best effort next to the ComCore
 * relay; none for any other source.
 */
export function extraRelaysFor(config: Pick<StoreConfig, 'source'>): string[] {
  return config.source.kind === 'paycore'
    ? DEFAULT_RELAYS.filter((relay) => !COMCORE_RELAYS.includes(relay))
    : [];
}

/** On an extra relay: the owner's 30490/kind 5 and the source key's listings. */
export function extraFilters(owner: string, productKey: string | undefined): Filter[] {
  const filters: Filter[] = [{ kinds: [KIND_STORE_AUTH, KIND_DELETION], authors: [owner] }];
  if (productKey !== undefined) {
    filters.push({ kinds: [KIND_PRODUCT, KIND_DELETION], authors: [productKey] });
  }
  return filters;
}

/** The keys' events once the config names them: listings, policies and their deletions. */
export function keyFilters(
  productKey: string | undefined,
  policyKey: string | undefined,
): Filter[] {
  const filters: Filter[] = [];
  if (productKey !== undefined) {
    filters.push({ kinds: [KIND_PRODUCT, KIND_DELETION], authors: [productKey] });
  }
  if (policyKey !== undefined && policyKey !== productKey) {
    filters.push({ kinds: [KIND_POLICY, KIND_DELETION], authors: [policyKey] });
  } else if (policyKey !== undefined) {
    filters.push({ kinds: [KIND_POLICY], authors: [policyKey] });
  }
  return filters;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/** The newest genuine event per `d` of a kind by an author, unless a newer deletion names it. */
function newestPerAddress(
  events: readonly NostrEvent[],
  kind: number,
  author: string,
  now: number,
): NostrEvent[] {
  const ds = new Set(
    events
      .filter((event) => event.kind === kind && event.pubkey === author)
      .map((event) => tagValue(event, 'd'))
      .filter((d): d is string => d !== undefined),
  );
  const kept: NostrEvent[] = [];
  for (const d of ds) {
    const newest = newestSigned(events, kind, author, now, d);
    if (!newest) {
      continue;
    }
    const deletion = newestDeletion(events, `${kind}:${author}:${d}`, author, now);
    if (deletion && deletion.created_at >= newest.created_at) {
      continue;
    }
    kept.push(newest);
  }
  return kept;
}

/** The store's config (30496) from the owner's events, when genuine, parseable and not deleted (NIP-09). */
export function storeConfig(
  events: readonly NostrEvent[],
  owner: string,
  now: number,
): StoreConfig | undefined {
  const event = newestSigned(events, KIND_CONFIG, owner, now, CONFIG_D_TAG);
  if (!event) {
    return undefined;
  }
  const deletion = newestDeletion(
    events,
    `${KIND_CONFIG}:${owner}:${CONFIG_D_TAG}`,
    owner,
    NO_FUTURE_LIMIT,
  );
  return deletion && deletion.created_at >= event.created_at ? undefined : parseConfig(event);
}

/**
 * Build a store's catalog from everything read for it (5.1): the config must
 * name this worker's assistant key; listings and policies come only from keys
 * the owner currently authorizes (1.2, 1.4), newest per address, minus deleted
 * ones. Returns undefined when the store is not servable.
 */
export function buildStoreCatalog(
  events: readonly NostrEvent[],
  owner: string,
  assistantSecretKey: Uint8Array,
  now: number,
): StoreCatalog | undefined {
  const config = storeConfig(events, owner, now);
  if (!config || config.assistant !== getPublicKey(assistantSecretKey)) {
    return undefined;
  }
  const authority = events.filter(
    (event) => event.pubkey === owner && AUTHORITY_KINDS.includes(event.kind),
  );
  const keys = resolveStoreKeys(config, authority, now);
  const items: CatalogItem[] = [];
  if (keys.productKey !== undefined && keys.productRole !== undefined) {
    const role = keys.productRole;
    for (const event of newestPerAddress(events, KIND_PRODUCT, keys.productKey, now)) {
      const item = parseCatalogItem(event, { now, role });
      if (item) {
        items.push(item);
      }
    }
  }
  const policies: Policy[] = [];
  if (keys.policyKey !== undefined) {
    for (const event of newestPerAddress(events, KIND_POLICY, keys.policyKey, now)) {
      const policy = parsePolicy(event);
      if (policy) {
        policies.push(policy);
      }
    }
  }
  return new StoreCatalog(
    config,
    decryptPrivateConfig(config, assistantSecretKey),
    items,
    policies,
  );
}
