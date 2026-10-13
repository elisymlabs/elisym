/**
 * What the admin reads about the store: the profile (name and owner), the
 * inbox relays and the payout list first; then the listings of exactly the
 * products the loaded orders name - the products an order may name, and the
 * mediums a receipt may use.
 */
import {
  KIND_INBOX_RELAYS,
  KIND_PAYTO,
  KIND_PRODUCT,
  KIND_STORE_PROFILE,
  type UnwrappedOrderMessage,
  isPurchasable,
  parseCaip19,
  parsePayto,
  parseProduct,
  parseStoreProfile,
  productAddress,
} from '@elisym/commerce';
import {
  DEFAULT_RELAYS,
  type RelayClient,
  mediumOf,
  newestGenuine,
  newestStoreInbox,
} from '@elisym/commerce/buyer';
import type { NostrEvent } from 'nostr-tools';
import { ALL_LISTINGS_MAX_PAGES, ALL_LISTINGS_PAGE_LIMIT } from '../constants';
import { readListingChunks } from '../listing-reads';
import { orderKey } from '../order-rules';
import type { AdminListing, AdminStore } from './history';

export interface StoreView {
  /** The store's profile name, to tell the merchant it is the right store. */
  name?: string;
  /** Where its wraps are read: its inbox list, else the default relays. */
  relays: string[];
  /** No inbox list was found: the default relays are read instead. */
  noInboxList: boolean;
  /** The mediums of the owner's payout list. */
  payoutMediums: string[];
}

/** The newest listing read of each product, by product address: never dropped once read. */
export type KeptListings = ReadonlyMap<string, NostrEvent>;

/** The relays the store's listings and payout list are read from: the defaults and its inbox. */
export function storeRelays(view: Pick<StoreView, 'relays'>): string[] {
  return [...DEFAULT_RELAYS, ...view.relays.filter((relay) => !DEFAULT_RELAYS.includes(relay))];
}

/** Read the store's profile, inbox list and payout list, one query after the other. */
export async function readStore(
  client: RelayClient,
  storePubkey: string,
  now: number,
): Promise<StoreView> {
  const first = await client.query(DEFAULT_RELAYS, [
    { kinds: [KIND_STORE_PROFILE, KIND_INBOX_RELAYS], authors: [storePubkey] },
  ]);
  const inbox = newestStoreInbox(first, storePubkey, now);
  const profileEvent = newestGenuine(first, KIND_STORE_PROFILE, storePubkey, now);
  const profile = profileEvent === undefined ? undefined : parseStoreProfile(profileEvent);
  const owner = profile?.ownerPubkey;
  const relays = inbox === undefined ? [...DEFAULT_RELAYS] : inbox.relays;
  const payto =
    owner === undefined
      ? undefined
      : newestGenuine(
          await client.query(storeRelays({ relays }), [{ kinds: [KIND_PAYTO], authors: [owner] }]),
          KIND_PAYTO,
          owner,
          now,
        );
  const payoutMediums = new Set<string>();
  for (const target of payto === undefined ? [] : parsePayto(payto).targets) {
    payoutMediums.add(mediumOf(target.caip19.chain));
  }
  return {
    ...(profile?.name === undefined ? {} : { name: profile.name }),
    relays,
    noInboxList: inbox === undefined,
    payoutMediums: [...payoutMediums],
  };
}

/** The `d` of a product address of this store, or `undefined` for another store's. */
function dOf(address: string, storePubkey: string): string | undefined {
  const prefix = `${KIND_PRODUCT}:${storePubkey}:`;
  return address.startsWith(prefix) ? address.slice(prefix.length) : undefined;
}

/**
 * The product addresses of this store that the loaded orders name, each with
 * the orders naming it (`<buyer>:<orderId>`). Only orders a buyer sealed to the
 * store, about the store.
 */
export function namedProducts(
  messages: readonly UnwrappedOrderMessage[],
  storePubkey: string,
): Map<string, Set<string>> {
  const named = new Map<string, Set<string>>();
  for (const { message, senderPubkey, recipientPubkey } of messages) {
    if (
      message.type !== 'order' ||
      senderPubkey === storePubkey ||
      recipientPubkey !== storePubkey ||
      message.storePubkey !== storePubkey
    ) {
      continue;
    }
    const [item, ...rest] = message.items;
    if (item === undefined || rest.length > 0 || dOf(item.product, storePubkey) === undefined) {
      continue;
    }
    const orders = named.get(item.product) ?? new Set<string>();
    orders.add(orderKey(senderPubkey, message.orderId));
    named.set(item.product, orders);
  }
  return named;
}

/**
 * Read the listings of `addresses` (chunked `'#d'` reads, a few at a time) and
 * merge them into `kept` by the newest rule (the newest `created_at`, then the
 * lowest id, dated no further ahead than allowed). An address read empty keeps
 * what was read before: a relay outage never hides orders.
 */
export async function readListings(
  client: RelayClient,
  relays: readonly string[],
  storePubkey: string,
  addresses: readonly string[],
  kept: KeptListings,
  now: number,
): Promise<Map<string, NostrEvent>> {
  const ds = addresses.flatMap((address) => {
    const d = dOf(address, storePubkey);
    return d === undefined ? [] : [d];
  });
  const events = await readListingChunks(ds, (chunk) =>
    client.query(relays, [{ kinds: [KIND_PRODUCT], authors: [storePubkey], '#d': chunk }]),
  );
  return mergeNewestListings(kept, events, storePubkey, now);
}

/** Whether `event` wins over `other` by the newest rule: the newest `created_at`, then the lowest id. */
function isNewer(event: NostrEvent, other: NostrEvent): boolean {
  return (
    event.created_at > other.created_at ||
    (event.created_at === other.created_at && event.id < other.id)
  );
}

/**
 * Merge listing events into `kept` by product address, the newest genuine one
 * winning (the newest `created_at`, then the lowest id, dated no further ahead
 * than allowed). Nothing already kept is dropped. A kept listing was checked
 * when it was kept: only new candidates are checked (a signature check is
 * about a millisecond, and a store's listings arrive once per relay).
 */
export function mergeNewestListings(
  kept: KeptListings,
  events: readonly NostrEvent[],
  storePubkey: string,
  now: number,
): Map<string, NostrEvent> {
  const byAddress = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (d === undefined) {
      continue;
    }
    const address = productAddress({ storePubkey, d });
    byAddress.set(address, [...(byAddress.get(address) ?? []), event]);
  }
  const merged = new Map(kept);
  for (const [address, candidates] of byAddress) {
    const before = kept.get(address);
    const fresh =
      before === undefined
        ? candidates
        : candidates.filter(
            (candidate) => candidate.id !== before.id || candidate.sig !== before.sig,
          );
    const newest = newestGenuine(fresh, KIND_PRODUCT, storePubkey, now);
    if (
      newest !== undefined &&
      (before === undefined || isNewer(newest, before)) &&
      parseProduct(newest) !== undefined
    ) {
      merged.set(address, newest);
    }
  }
  return merged;
}

/**
 * Every listing of the store, for the hosted admin's product list. Each relay
 * is paged on its own (one subscription per relay at a time), by `until`, until
 * a page brings no event not seen from it. `incomplete` when a relay still
 * brought new events after `ALL_LISTINGS_MAX_PAGES` pages, or stopped on a full
 * page of nothing new (a same-second wall, or a relay ignoring `until`). Not
 * detected: more listings in one second than a relay's own cap below
 * `ALL_LISTINGS_PAGE_LIMIT`, and a dead relay, which reads as empty.
 */
export async function readAllListings(
  client: RelayClient,
  relays: readonly string[],
  storePubkey: string,
): Promise<{ events: NostrEvent[]; incomplete: boolean }> {
  const readRelay = async (relay: string) => {
    const seen = new Map<string, NostrEvent>();
    let until: number | undefined;
    // One page past the cap only to learn whether the list ended there.
    for (let page = 0; page <= ALL_LISTINGS_MAX_PAGES; page += 1) {
      const events = await client.query(
        [relay],
        [
          {
            kinds: [KIND_PRODUCT],
            authors: [storePubkey],
            limit: ALL_LISTINGS_PAGE_LIMIT,
            ...(until === undefined ? {} : { until }),
          },
        ],
      );
      const fresh = events.filter((event) => !seen.has(event.id));
      if (fresh.length === 0) {
        return { events: [...seen.values()], incomplete: events.length >= ALL_LISTINGS_PAGE_LIMIT };
      }
      if (page === ALL_LISTINGS_MAX_PAGES) {
        break;
      }
      for (const event of fresh) {
        seen.set(event.id, event);
      }
      until = events.reduce((oldest, event) => Math.min(oldest, event.created_at), Infinity);
    }
    return { events: [...seen.values()], incomplete: true };
  };
  const results = await Promise.all(relays.map(readRelay));
  // Relays answer copies of the same listings: each exact copy is checked once.
  const copies = new Map<string, NostrEvent>();
  for (const event of results.flatMap((result) => result.events)) {
    copies.set(
      JSON.stringify([
        event.id,
        event.sig,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
      ]),
      event,
    );
  }
  return {
    events: [...copies.values()],
    incomplete: results.some((result) => result.incomplete),
  };
}

/** One product of the store as the admin shows it. */
export interface ProductLine {
  address: string;
  d: string;
  title: string;
  price: string;
  onSale: boolean;
}

/** The store's products read so far, by `d`. */
export function productLines(kept: KeptListings): ProductLine[] {
  const lines: ProductLine[] = [];
  for (const [address, event] of kept) {
    const product = parseProduct(event);
    if (product !== undefined) {
      lines.push({
        address,
        d: product.d,
        title: product.title,
        price: `${product.price.amount} ${product.price.currency}`,
        onSale: isPurchasable(product),
      });
    }
  }
  return lines.sort((first, second) => (first.d < second.d ? -1 : 1));
}

/** The store as the history judges orders: the products read, and the mediums they and the payout list take. */
export function adminStoreOf(storePubkey: string, view: StoreView, kept: KeptListings): AdminStore {
  const mediums = new Set(view.payoutMediums);
  const listings = new Map<string, AdminListing>();
  for (const [address, event] of kept) {
    const product = parseProduct(event);
    if (product === undefined) {
      continue;
    }
    for (const id of product.accept) {
      const caip19 = parseCaip19(id);
      if (caip19 !== undefined) {
        mediums.add(mediumOf(caip19.chain));
      }
    }
    listings.set(address, {
      price: product.price,
      createdAt: product.createdAt,
      title: product.title,
    });
  }
  return {
    storePubkey,
    productAddresses: new Set(listings.keys()),
    mediums: [...mediums],
    listings,
  };
}

/**
 * How many loaded orders name a product whose listing was not found: they are
 * hidden (an unknown product, or the relays did not answer).
 */
export function hiddenOrders(named: ReadonlyMap<string, Set<string>>, kept: KeptListings): number {
  let hidden = 0;
  for (const [address, orders] of named) {
    if (!kept.has(address)) {
      hidden += orders.size;
    }
  }
  return hidden;
}

/**
 * A fresh read of the store, keeping what an earlier read found where this
 * one found nothing: the relays answer an empty list when they are down, and
 * a brief outage must not hide every order. `stale` says something was kept.
 */
export function keepWhatWasRead(
  previous: StoreView,
  fresh: StoreView,
): { view: StoreView; stale: boolean } {
  const lostInbox = fresh.noInboxList && !previous.noInboxList;
  const lostPayouts = fresh.payoutMediums.length === 0 && previous.payoutMediums.length > 0;
  const name = fresh.name ?? previous.name;
  return {
    view: {
      ...(name === undefined ? {} : { name }),
      relays: lostInbox ? previous.relays : fresh.relays,
      noInboxList: lostInbox ? previous.noInboxList : fresh.noInboxList,
      payoutMediums: lostPayouts ? previous.payoutMediums : fresh.payoutMediums,
    },
    stale: lostInbox || lostPayouts,
  };
}
