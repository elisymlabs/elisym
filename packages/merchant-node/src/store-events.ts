import { createHash } from 'node:crypto';
import {
  KIND_INBOX_RELAYS,
  buildPaytoEvent,
  buildProductEvent,
  buildStoreAuthEvent,
  buildStoreProfileEvent,
  encodeProductNaddr,
  parseCaip19,
  priceInSubunits,
  splitNip05,
} from '@elisym/commerce';
import { type NostrEvent, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Product } from './products';
import type { ListingTerms, PayoutTerms } from './terms';

/** The nostr.json name commerce reads the owner key from. */
const NOSTR_JSON_OWNER_NAME = 'owner';

/** A stopped product's listing visibility: buyers refuse it. */
const SOLD_OUT = 'sold-out';
const ON_SALE = 'on-sale';

export interface StoreConfig {
  /** Store profile name. */
  name: string;
  /** `_@shop.example`: the domain that vouches for the store (level A), or none (level C). */
  nip05?: string;
  /** One payout per accepted coin: CAIP-19 id and the owner's wallet address. */
  payouts: { caip19: string; address: string; signature?: string }[];
  /** The store's inbox relays (kind 10050): where it reads orders and replies. */
  inboxRelays: string[];
}

export interface StoreKeys {
  storeSecretKey: Uint8Array;
  ownerSecretKey: Uint8Array;
}

/** The product fields a listing is built from. */
export type ListedProduct = Pick<
  Product,
  'd' | 'title' | 'description' | 'summary' | 'priceUsd' | 'onSale'
>;

/**
 * What the domain's `/.well-known/nostr.json` serves for this store: built from
 * the public keys alone, so `check` reports the domain without the owner's
 * secret. The store cannot take the name `owner`, which names the owner key.
 * It gives level A only under the domain-wide name `_` (nip05 `_@domain` or a
 * bare domain); a named nip05 such as `shop@domain` stays level C.
 */
export function storeNostrJson(
  config: Pick<StoreConfig, 'nip05'>,
  storePubkey: string,
  ownerPubkey: string,
): { names: Record<string, string> } {
  const local = config.nip05 === undefined ? '_' : (splitNip05(config.nip05)?.local ?? '_');
  if (local === NOSTR_JSON_OWNER_NAME) {
    throw new Error(
      `The store's nip05 name cannot be "${NOSTR_JSON_OWNER_NAME}": it names the owner`,
    );
  }
  return { names: { [local]: storePubkey, [NOSTR_JSON_OWNER_NAME]: ownerPubkey } };
}

/** A product's coins at its price in each: the listing side of its terms. */
export function listingTerms(
  product: Pick<Product, 'priceUsd'>,
  payouts: StoreConfig['payouts'],
): ListingTerms[] {
  const price = { amount: product.priceUsd, currency: 'USD' };
  return payouts.map((payout) => {
    const caip19 = parseCaip19(payout.caip19);
    if (caip19 === undefined) {
      throw new Error(`Not a payable CAIP-19 asset: ${payout.caip19}`);
    }
    return { caip19: caip19.id, amount: priceInSubunits(price, caip19.asset).toString() };
  });
}

/** Payouts (the configured ones, or the ones a recorded payout list held) as the payout side of terms. */
export function payoutTerms(
  payouts: readonly { caip19: string; address: string }[],
): PayoutTerms[] {
  return payouts.flatMap((payout) => {
    const caip19 = parseCaip19(payout.caip19);
    return caip19 === undefined ? [] : [{ caip19: caip19.id, payout: payout.address }];
  });
}

/**
 * The content of a product's listing, never its date: sha256 of its `d`, text,
 * price and visibility, and - on sale only - its coins. A sold-out listing
 * still carries coins (a listing needs one) but offers nothing, so a coin
 * change does not republish it.
 */
export function listingHash(product: ListedProduct, payouts: StoreConfig['payouts']): string {
  const content = [
    product.d,
    product.title,
    product.summary ?? null,
    product.description,
    product.priceUsd,
    'USD',
    product.onSale ? ON_SALE : SOLD_OUT,
    product.onSale ? payouts.map((payout) => payout.caip19) : [],
  ];
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
}

/** A product's listing (kind 30402), signed by the store key at `createdAt`. */
export function buildListingEvent(
  product: ListedProduct,
  payouts: StoreConfig['payouts'],
  storeSecretKey: Uint8Array,
  createdAt: number,
): NostrEvent {
  return finalizeEvent(
    buildProductEvent({
      d: product.d,
      title: product.title,
      description: product.description,
      ...(product.summary === undefined ? {} : { summary: product.summary }),
      price: { amount: product.priceUsd, currency: 'USD' },
      visibility: product.onSale ? ON_SALE : SOLD_OUT,
      accept: payouts.map((payout) => payout.caip19),
      createdAt,
    }),
    storeSecretKey,
  );
}

/** The naddr a page embeds for product `d`, with relay hints. */
export function productNaddr(storePubkey: string, d: string, hints: readonly string[]): string {
  return encodeProductNaddr({ storePubkey, d }, [...hints]);
}

/**
 * The store-wide events, signed: the owner's payout list (dated `paytoCreatedAt`),
 * then the profile, inbox list (store key) and authorization (owner key), at `createdAt`.
 */
export function buildStoreWideEvents(
  config: StoreConfig,
  keys: StoreKeys,
  createdAt: number,
  paytoCreatedAt: number,
  /** Declare protocol-fee support in the store profile (see `setup`): only a node that can judge splits. */
  feeSupport = false,
): { payoutList: NostrEvent; others: NostrEvent[] } {
  const storePubkey = getPublicKey(keys.storeSecretKey);
  const ownerPubkey = getPublicKey(keys.ownerSecretKey);
  const byOwner = (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, keys.ownerSecretKey);
  return {
    payoutList: byOwner(
      buildPaytoEvent({ ownerPubkey, accept: config.payouts, createdAt: paytoCreatedAt }),
    ),
    others: [
      ...storeSignedEvents(config, keys.storeSecretKey, ownerPubkey, createdAt, feeSupport),
      byOwner(buildStoreAuthEvent({ storePubkey, mode: 'self-host', createdAt })),
    ],
  };
}

/**
 * The store-wide events of a store-only home: the store's own, signed here, with
 * the owner's payout list and authorization as the owner signed them elsewhere.
 */
export function storeWideFromOwnerEvents(
  config: StoreConfig,
  storeSecretKey: Uint8Array,
  ownerPubkey: string,
  ownerEvents: { payoutList: NostrEvent; auth: NostrEvent },
  createdAt: number,
  feeSupport = false,
): { payoutList: NostrEvent; others: NostrEvent[] } {
  return {
    payoutList: ownerEvents.payoutList,
    others: [
      ...storeSignedEvents(config, storeSecretKey, ownerPubkey, createdAt, feeSupport),
      ownerEvents.auth,
    ],
  };
}

/**
 * The store-wide events of a withdrawal in a store-only home: the store's own
 * only. No payout list and no authorization: a sold-out store needs neither.
 */
export function storeWideWithoutOwnerEvents(
  config: StoreConfig,
  storeSecretKey: Uint8Array,
  ownerPubkey: string,
  createdAt: number,
  feeSupport = false,
): { payoutList: undefined; others: NostrEvent[] } {
  return {
    payoutList: undefined,
    others: storeSignedEvents(config, storeSecretKey, ownerPubkey, createdAt, feeSupport),
  };
}

/** The profile (naming the owner) and the inbox list, signed by the store key. */
function storeSignedEvents(
  config: StoreConfig,
  storeSecretKey: Uint8Array,
  ownerPubkey: string,
  createdAt: number,
  feeSupport: boolean,
): NostrEvent[] {
  const byStore = (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, storeSecretKey);
  return [
    byStore(
      buildStoreProfileEvent({
        name: config.name,
        ownerPubkey,
        createdAt,
        fee: feeSupport,
        // Every node from 0.11 accepts both Tempo memo forms for every order.
        memoMarker: true,
        ...(config.nip05 === undefined ? {} : { nip05: config.nip05 }),
      }),
    ),
    byStore({
      kind: KIND_INBOX_RELAYS,
      created_at: createdAt,
      tags: config.inboxRelays.map((relay) => ['relay', relay]),
      content: '',
    }),
  ];
}
