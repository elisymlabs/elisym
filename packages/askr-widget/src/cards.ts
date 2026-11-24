import {
  type CatalogItem,
  type StoreConfig,
  parseAddress,
  parseCatalogItem,
  readCatalogAuthority,
} from '@elisym/askr';
import type { Component } from '@elisym/askr/chat';
import { KIND_DELETION, isEventShaped, newestDeletion, newestSigned } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import {
  CARD_CACHE_PREFIX,
  CARD_CACHE_TTL_SECS,
  KIND_PRODUCT,
  MAX_CARD_ADDRESSES,
} from './constants';
import { type KeyValueStorage, readItem, writeItem } from './storage';
import type { RelayQuery } from './store-data';

/** Every product address an answer's components name, in order of first mention. */
export function componentAddresses(components: readonly Component[]): string[] {
  const addresses: string[] = [];
  for (const component of components) {
    if (component.type === 'products') {
      addresses.push(...component.picks.map((pick) => pick.address));
    } else if (component.type === 'comparison') {
      addresses.push(...component.addresses);
    } else if (component.type === 'plan') {
      for (const step of component.steps) {
        addresses.push(...step.addresses);
      }
    }
  }
  return [...new Set(addresses)];
}

/**
 * Whether `author` is the store's product key right now: the config's
 * `catalog-key`, an authorized catalog key per `readCatalogAuthority`.
 */
export function isProductAuthor(
  author: string,
  config: Pick<StoreConfig, 'owner' | 'catalogKey'>,
  authorityEvents: readonly NostrEvent[],
  now: number,
): boolean {
  if (author !== config.catalogKey) {
    return false;
  }
  return readCatalogAuthority(authorityEvents, config.owner, now).has(author);
}

interface CachedCard {
  /** When it was fetched, unix seconds. */
  at: number;
  /** The listing as fetched, or null for an address confirmed missing or deleted. */
  event: NostrEvent | null;
}

/** Resolved listings in sessionStorage (4.3), re-read through the same parser on every use. */
export class CardCache {
  constructor(private readonly storage: KeyValueStorage | undefined) {}

  get(address: string, now: number): CachedCard | undefined {
    const raw = readItem(this.storage, `${CARD_CACHE_PREFIX}${address}`);
    if (raw === undefined) {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null) {
        return undefined;
      }
      const at: unknown = Reflect.get(value, 'at');
      const event: unknown = Reflect.get(value, 'event');
      if (typeof at !== 'number' || now - at > CARD_CACHE_TTL_SECS || now < at) {
        return undefined;
      }
      if (event === null) {
        return { at, event: null };
      }
      return isEventShaped(event) ? { at, event } : undefined;
    } catch {
      return undefined;
    }
  }

  set(address: string, card: CachedCard): void {
    writeItem(this.storage, `${CARD_CACHE_PREFIX}${address}`, JSON.stringify(card));
  }
}

export interface ResolveCardsOptions {
  config: StoreConfig;
  authorityEvents: readonly NostrEvent[];
  query: RelayQuery;
  cache: CardCache;
  /** Gateway-corrected unix seconds. */
  now: number;
}

/** The newest listing at `address` that no later NIP-09 deletion of its author removed. */
function liveListing(
  events: readonly NostrEvent[],
  author: string,
  d: string,
  address: string,
  now: number,
): NostrEvent | null {
  const listing = newestSigned(events, KIND_PRODUCT, author, now, d);
  if (!listing) {
    return null;
  }
  // Dated past the clock skew, a deletion counts no more than a listing would: the same rule as
  // the assistant's server and the admin, so all three read a deletion alike.
  const deletion = newestDeletion(events, address, author, now);
  return deletion && deletion.created_at >= listing.created_at ? null : listing;
}

/**
 * Resolve an answer's addresses into cards (4.3): never from message text,
 * always from the widget's own fetch of the catalog. At most 50 distinct
 * addresses per answer; an author that is not the store's current product key
 * is dropped without a fetch; one batched REQ (listings by `authors` + `#d`, plus
 * the kind 5 deletions naming those addresses) covers the rest. Deleted,
 * expired, hidden, unknown-visibility and unresolvable listings are absent
 * from the result.
 */
export async function resolveCards(
  addresses: readonly string[],
  options: ResolveCardsOptions,
): Promise<Map<string, CatalogItem>> {
  const { config, now } = options;
  const budgeted = [...new Set(addresses)].slice(0, MAX_CARD_ADDRESSES);
  const wanted = budgeted.filter((address) => {
    const parsed = parseAddress(address);
    return (
      parsed !== undefined &&
      parsed.kind === KIND_PRODUCT &&
      isProductAuthor(parsed.author, config, options.authorityEvents, now)
    );
  });
  const listings = new Map<string, NostrEvent | null>();
  const missing: string[] = [];
  for (const address of wanted) {
    const cached = options.cache.get(address, now);
    if (cached) {
      listings.set(address, cached.event);
    } else {
      missing.push(address);
    }
  }
  if (missing.length > 0) {
    const ds = missing.map((address) => parseAddress(address)?.d ?? '');
    const events = await options.query([
      { kinds: [KIND_PRODUCT], authors: [config.catalogKey], '#d': ds },
      { kinds: [KIND_DELETION], authors: [config.catalogKey], '#a': missing },
    ]);
    missing.forEach((address, index) => {
      const listing = liveListing(events, config.catalogKey, ds[index] ?? '', address, now);
      listings.set(address, listing);
      options.cache.set(address, { at: now, event: listing });
    });
  }
  const cards = new Map<string, CatalogItem>();
  for (const [address, listing] of listings) {
    const item = listing
      ? parseCatalogItem(listing, { now, catalogKey: config.catalogKey })
      : undefined;
    if (item && item.address === address) {
      cards.set(address, item);
    }
  }
  return cards;
}
