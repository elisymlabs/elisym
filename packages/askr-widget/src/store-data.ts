import {
  CONFIG_D_TAG,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  type StoreConfig,
  parseConfig,
} from '@elisym/askr';
import { KIND_DELETION, KIND_STORE_AUTH, newestDeletion, newestSigned } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

/** A history read on the Askr relay; it rejects when the relay fails. */
export type RelayQuery = (filters: Filter[]) => Promise<NostrEvent[]>;

export interface StoreData {
  config: StoreConfig;
  /**
   * The owner's 30497, 30490 and kind 5 events: what `readCatalogAuthority` and
   * `readPayableKeys` read.
   */
  authorityEvents: NostrEvent[];
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
  // A deletion dated past the clock skew is ignored, like a config would be (the server's rule).
  const deletion = newestDeletion(events, `${KIND_CONFIG}:${owner}:${CONFIG_D_TAG}`, owner, now);
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
 * Fetch the store's 30496 config and the owner's authority events (6), from
 * the Askr relay only: compiled in, neither the gateway nor the snippet can
 * change it.
 */
export async function loadStoreData(
  owner: string,
  query: RelayQuery,
  now: number,
): Promise<StoreData | undefined> {
  const events = await query(storeFilters(owner));
  const config = readStoreConfig(events, owner, now);
  if (!config) {
    return undefined;
  }
  const authorityEvents = events.filter((event) => isAuthorityEvent(event, owner));
  return { config, authorityEvents };
}
