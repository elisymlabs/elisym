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
import type { OfferTerms } from './terms';

/** The nostr.json name commerce reads the owner key from. */
const NOSTR_JSON_OWNER_NAME = 'owner';

export interface StoreConfig {
  /** Store profile name. */
  name: string;
  /** `_@shop.example`: the domain that vouches for the store (level A), or none (level C). */
  nip05?: string;
  product: {
    d: string;
    title: string;
    description: string;
    summary?: string;
    /** USD, e.g. `"1"` or `"49.00"`: paid 1:1 in a USD coin. */
    priceUsd: string;
  };
  /** One payout per accepted coin: CAIP-19 id and the owner's wallet address. */
  payouts: { caip19: string; address: string; signature?: string }[];
  /** The store's inbox relays (kind 10050): where it reads orders and replies. */
  inboxRelays: string[];
}

export interface StoreKeys {
  storeSecretKey: Uint8Array;
  ownerSecretKey: Uint8Array;
}

export interface StoreEvents {
  /** Signed, ready to publish: product, profile, inbox list (store key); payouts, authorization (owner key). */
  events: NostrEvent[];
  naddr: string;
  /** The terms these events offer, one per payout: what the ledger records. */
  terms: OfferTerms[];
  /** What the domain's `/.well-known/nostr.json` must serve for level A (with CORS). */
  nostrJson: { names: Record<string, string> };
}

/** Build and sign everything a store publishes, at `createdAt`. */
export function buildStoreEvents(
  config: StoreConfig,
  keys: StoreKeys,
  createdAt: number,
  options: {
    hints?: readonly string[];
    /**
     * When the unchanged payout list was first signed: republishing it with a new
     * date would restart every buyer's "payout recently changed" cool-down.
     */
    paytoCreatedAt?: number;
  } = {},
): StoreEvents {
  const storePubkey = getPublicKey(keys.storeSecretKey);
  const ownerPubkey = getPublicKey(keys.ownerSecretKey);
  const price = { amount: config.product.priceUsd, currency: 'USD' };
  const terms: OfferTerms[] = config.payouts.map((payout) => {
    const caip19 = parseCaip19(payout.caip19);
    if (caip19 === undefined) {
      throw new Error(`Not a payable CAIP-19 asset: ${payout.caip19}`);
    }
    return {
      caip19: caip19.id,
      payout: payout.address,
      amount: priceInSubunits(price, caip19.asset).toString(),
    };
  });
  const byStore = (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, keys.storeSecretKey);
  const byOwner = (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, keys.ownerSecretKey);
  const events = [
    byStore(
      buildProductEvent({
        d: config.product.d,
        title: config.product.title,
        description: config.product.description,
        ...(config.product.summary === undefined ? {} : { summary: config.product.summary }),
        price,
        accept: config.payouts.map((payout) => payout.caip19),
        createdAt,
      }),
    ),
    byStore(
      buildStoreProfileEvent({
        name: config.name,
        ownerPubkey,
        createdAt,
        ...(config.nip05 === undefined ? {} : { nip05: config.nip05 }),
      }),
    ),
    byStore({
      kind: KIND_INBOX_RELAYS,
      created_at: createdAt,
      tags: config.inboxRelays.map((relay) => ['relay', relay]),
      content: '',
    }),
    byOwner(
      buildPaytoEvent({
        ownerPubkey,
        accept: config.payouts,
        createdAt: options.paytoCreatedAt ?? createdAt,
      }),
    ),
    byOwner(buildStoreAuthEvent({ storePubkey, mode: 'self-host', createdAt })),
  ];
  const local = config.nip05 === undefined ? '_' : (splitNip05(config.nip05)?.local ?? '_');
  // `owner` names the owner key in nostr.json: a store under that name would be lost.
  if (local === NOSTR_JSON_OWNER_NAME) {
    throw new Error(
      `The store's nip05 name cannot be "${NOSTR_JSON_OWNER_NAME}": it names the owner`,
    );
  }
  return {
    events,
    naddr: encodeProductNaddr({ storePubkey, d: config.product.d }, [...(options.hints ?? [])]),
    terms,
    nostrJson: { names: { [local]: storePubkey, [NOSTR_JSON_OWNER_NAME]: ownerPubkey } },
  };
}
