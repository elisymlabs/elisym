/**
 * What the admin reads about the store before its orders: the profile (name
 * and owner), the inbox relays, the published listings and the payout list -
 * the products an order may name and the mediums a receipt may use.
 */
import {
  KIND_INBOX_RELAYS,
  KIND_PAYTO,
  KIND_PRODUCT,
  KIND_STORE_PROFILE,
  type Product,
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
import type { AdminStore } from './history';

export interface StoreView {
  store: AdminStore;
  /** The store's profile name, to tell the merchant it is the right store. */
  name?: string;
  /** Where its wraps are read: its inbox list, else the default relays. */
  relays: string[];
  /** No inbox list was found: the default relays are read instead. */
  noInboxList: boolean;
  /** The `d` of every listing the store published. */
  listings: string[];
}

/** The newest genuine listing per `d` the store signed, dated no further ahead than allowed. */
function newestListings(
  events: readonly NostrEvent[],
  storePubkey: string,
  now: number,
): Product[] {
  const byD = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (event.kind !== KIND_PRODUCT || event.pubkey !== storePubkey || d === undefined) {
      continue;
    }
    byD.set(d, [...(byD.get(d) ?? []), event]);
  }
  const products: Product[] = [];
  for (const candidates of byD.values()) {
    const newest = newestGenuine(candidates, KIND_PRODUCT, storePubkey, now);
    const product = newest === undefined ? undefined : parseProduct(newest);
    if (product !== undefined) {
      products.push(product);
    }
  }
  return products;
}

/** Read the store's profile, inbox list, listings and payout list. */
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

  const named = inbox?.relays ?? [];
  const readFrom = [...DEFAULT_RELAYS, ...named.filter((relay) => !DEFAULT_RELAYS.includes(relay))];
  const second = await client.query(readFrom, [
    { kinds: [KIND_PRODUCT], authors: [storePubkey] },
    ...(owner === undefined ? [] : [{ kinds: [KIND_PAYTO], authors: [owner] }]),
  ]);
  const products = newestListings(second, storePubkey, now);
  const payto = owner === undefined ? undefined : newestGenuine(second, KIND_PAYTO, owner, now);

  const mediums = new Set<string>();
  for (const target of payto === undefined ? [] : parsePayto(payto).targets) {
    mediums.add(mediumOf(target.caip19.chain));
  }
  for (const product of products) {
    for (const id of product.accept) {
      const caip19 = parseCaip19(id);
      if (caip19 !== undefined) {
        mediums.add(mediumOf(caip19.chain));
      }
    }
  }

  const listings = new Map<string, { price: Product['price']; createdAt: number }>();
  for (const product of products) {
    listings.set(productAddress(product), { price: product.price, createdAt: product.createdAt });
  }
  return {
    store: {
      storePubkey,
      productAddresses: new Set(listings.keys()),
      mediums: [...mediums],
      listings,
    },
    ...(profile?.name === undefined ? {} : { name: profile.name }),
    relays: inbox === undefined ? [...DEFAULT_RELAYS] : inbox.relays,
    noInboxList: inbox === undefined,
    listings: products.map((product) => product.d),
  };
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
  const lostListings = fresh.listings.length === 0 && previous.listings.length > 0;
  const name = fresh.name ?? previous.name;
  return {
    view: {
      store: lostListings ? previous.store : fresh.store,
      ...(name === undefined ? {} : { name }),
      relays: lostInbox ? previous.relays : fresh.relays,
      noInboxList: lostInbox ? previous.noInboxList : fresh.noInboxList,
      listings: lostListings ? previous.listings : fresh.listings,
    },
    stale: lostInbox || lostListings,
  };
}
