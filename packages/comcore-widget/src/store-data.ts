import {
  COMCORE_RELAYS,
  CONFIG_D_TAG,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  type StoreConfig,
  parseConfig,
} from '@elisym/comcore';
import {
  KIND_DELETION,
  KIND_STORE_AUTH,
  NO_FUTURE_LIMIT,
  newestDeletion,
  newestSigned,
} from '@elisym/commerce';
import { DEFAULT_RELAYS } from '@elisym/commerce/buyer';
import type { NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

/** A history read over some relays; it rejects only when the main ComCore relay fails. */
export type RelayQuery = (relays: readonly string[], filters: Filter[]) => Promise<NostrEvent[]>;

export interface StoreData {
  config: StoreConfig;
  /** The owner's 30490, 30497 and kind 5 events: what `readCatalogAuthority` reads. */
  authorityEvents: NostrEvent[];
}

/**
 * Where the store's products live (2.4): the ComCore relay, plus commerce's
 * default relays for a Pay Core source (where Pay Core buyers read listings).
 * Compiled in: neither the gateway nor the snippet can change it.
 */
export function productRelays(config: Pick<StoreConfig, 'source'>): readonly string[] {
  if (config.source.kind !== 'paycore') {
    return COMCORE_RELAYS;
  }
  return [...COMCORE_RELAYS, ...DEFAULT_RELAYS.filter((relay) => !COMCORE_RELAYS.includes(relay))];
}

export function storeFilters(owner: string): Filter[] {
  return [
    { kinds: [KIND_CONFIG], authors: [owner], '#d': [CONFIG_D_TAG] },
    { kinds: [KIND_CATALOG_AUTH, KIND_STORE_AUTH, KIND_DELETION], authors: [owner] },
  ];
}

/** The owner's current config, or none: missing, unreadable, or deleted by NIP-09. */
export function readStoreConfig(
  events: readonly NostrEvent[],
  owner: string,
  now: number,
): StoreConfig | undefined {
  const newest = newestSigned(events, KIND_CONFIG, owner, now, CONFIG_D_TAG);
  if (!newest) {
    return undefined;
  }
  const deletion = newestDeletion(
    events,
    `${KIND_CONFIG}:${owner}:${CONFIG_D_TAG}`,
    owner,
    NO_FUTURE_LIMIT,
  );
  if (deletion && deletion.created_at >= newest.created_at) {
    return undefined;
  }
  return parseConfig(newest);
}

function isAuthorityEvent(event: NostrEvent, owner: string): boolean {
  return (
    event.pubkey === owner &&
    (event.kind === KIND_CATALOG_AUTH ||
      event.kind === KIND_STORE_AUTH ||
      event.kind === KIND_DELETION)
  );
}

/**
 * Fetch the store's 30496 config and the owner's authority events (6). A Pay
 * Core store's 30490 may live only where Pay Core publishes, so for that
 * source the default relays are read too.
 */
export async function loadStoreData(
  owner: string,
  query: RelayQuery,
  now: number,
): Promise<StoreData | undefined> {
  const events = await query(COMCORE_RELAYS, storeFilters(owner));
  const config = readStoreConfig(events, owner, now);
  if (!config) {
    return undefined;
  }
  const authorityEvents = events.filter((event) => isAuthorityEvent(event, owner));
  const extraRelays = productRelays(config).filter((relay) => !COMCORE_RELAYS.includes(relay));
  if (extraRelays.length > 0) {
    const extra = await query(extraRelays, [
      { kinds: [KIND_STORE_AUTH, KIND_DELETION], authors: [owner] },
    ]);
    const known = new Set(authorityEvents.map((event) => event.id));
    for (const event of extra) {
      if (isAuthorityEvent(event, owner) && !known.has(event.id)) {
        known.add(event.id);
        authorityEvents.push(event);
      }
    }
  }
  return { config, authorityEvents };
}
