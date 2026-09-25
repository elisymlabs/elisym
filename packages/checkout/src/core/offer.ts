import {
  type DomainKeys,
  type FetchLike,
  type OfferRefusal,
  type OfferWarning,
  type PayoutTarget,
  type VerifiedOffer,
  decodeProductNaddr,
  priceInSubunits,
  productAddress,
  verifyOffer,
} from '@elisym/commerce';
import type { ChainFamily, Network } from '@elisym/pay-core';
import { OFFER_SNAPSHOT_MAX_AGE_SECS } from './constants';
import { nowSecs } from './events';
import type { RelayClient } from './relay-client';
import { readRelays, uniqueRelays } from './relays';

/** Warnings the buyer must confirm, for the exact payout, before paying. */
export const CONFIRM_WARNINGS: readonly OfferWarning[] = [
  'payout_recently_changed',
  'payout_changed',
];

/** A payout the widget can pay: priced in that coin's subunits. */
export interface PricedPayout {
  target: PayoutTarget;
  /** The product's price in the coin's subunits (quantity 1). */
  amount: bigint;
}

export type WidgetRefusal =
  | OfferRefusal
  /** The page's origin is opaque or not an http(s) origin. */
  | 'bad_page_origin'
  /** No payout the widget can price and pay on the allowed rails and networks. */
  | 'no_payable_payout';

export type LoadedOffer =
  | {
      ok: true;
      offer: VerifiedOffer;
      /** `30402:<store>:<d>`: the key the widget's records are indexed by. */
      productAddress: string;
      payouts: PricedPayout[];
      /** Warnings that need an explicit confirmation before paying. */
      confirm: OfferWarning[];
      /** Warnings that are only shown. */
      notices: OfferWarning[];
      /** The naddr's usable relay hints (store-named, so capped with the inbox later). */
      hints: string[];
      /** Where the offer was read: the default relays plus the capped hints. */
      relays: string[];
      /** When this snapshot was taken (seconds). */
      snapshotAt: number;
    }
  | { ok: false; refusal: WidgetRefusal; message: string };

export interface StorePins {
  /** The owner pinned at the first purchase from this store. */
  pinnedOwnerPubkey?: string;
  /** Every payout of every verified offer that delivered from this store. */
  knownPayouts?: readonly { caip19: string; address: string }[];
}

export interface LoadOfferOptions {
  client: RelayClient;
  /** The embedding page's origin, from the accepted `hello`. */
  pageOrigin: string;
  /** Set by the page's `strict-origin` attribute: also refuse at levels B and C. */
  strictOrigin?: boolean;
  pins?: StorePins;
  /** Rails the widget can pay on now: required, so a new rail is offered only once it is built. */
  families: readonly ChainFamily[];
  /** The page's `network` attribute: only payouts on this network are offered. */
  network?: Network;
  now?: number;
  /** Domain lookups (nostr.json, DoH); defaults to the global `fetch`. */
  fetch?: FetchLike;
  resolveDomain?: (nip05: string) => Promise<DomainKeys | undefined>;
}

/** Whether `value` is a real http(s) origin, in its canonical spelling. */
export function isPageOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value === 'null') {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

/** Whether a snapshot taken at `snapshotAt` must be verified again before use. */
export function isSnapshotStale(snapshotAt: number, now: number = nowSecs()): boolean {
  return now - snapshotAt > OFFER_SNAPSHOT_MAX_AGE_SECS;
}

function refuse(refusal: WidgetRefusal, message: string): LoadedOffer {
  return { ok: false, refusal, message };
}

/**
 * Verify the offer behind `naddr` for this page and apply the widget's own
 * policy on top: a level A store the page is not on is refused (not only warned
 * about), and only payouts the widget can price and pay are offered.
 */
export async function loadOffer(naddr: string, options: LoadOfferOptions): Promise<LoadedOffer> {
  if (!isPageOrigin(options.pageOrigin)) {
    return refuse('bad_page_origin', 'The page embedding the checkout has no usable origin');
  }
  const pointer = decodeProductNaddr(naddr);
  if (pointer === undefined) {
    return refuse('bad_pointer', 'Not a product naddr');
  }
  const now = options.now ?? nowSecs();
  const hints = uniqueRelays(pointer.relays);
  const relays = readRelays({ hints });
  const verification = await verifyOffer(
    naddr,
    {
      fetchEvents: (filters) => options.client.query(relays, filters),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.resolveDomain === undefined ? {} : { resolveDomain: options.resolveDomain }),
    },
    {
      now,
      pageOrigin: options.pageOrigin,
      ...(options.strictOrigin === true ? { strictOrigin: true } : {}),
      ...(options.pins?.pinnedOwnerPubkey === undefined
        ? {}
        : { pinnedOwnerPubkey: options.pins.pinnedOwnerPubkey }),
      ...(options.pins?.knownPayouts === undefined
        ? {}
        : { knownPayouts: options.pins.knownPayouts }),
    },
  );
  if (!verification.ok) {
    return refuse(verification.refusal, verification.message);
  }
  const { offer } = verification;
  // A level A store vouches for one domain; a page elsewhere is refused by default.
  if (offer.warnings.includes('origin_mismatch')) {
    return refuse('origin_mismatch', 'This store does not sell on this site');
  }
  const payouts: PricedPayout[] = [];
  for (const target of offer.payouts) {
    const { chain, asset } = target.caip19;
    if (!options.families.includes(chain.family)) {
      continue;
    }
    if (options.network !== undefined && chain.network !== options.network) {
      continue;
    }
    let amount: bigint;
    try {
      amount = priceInSubunits(offer.product.price, asset);
    } catch {
      continue;
    }
    if (amount > 0n) {
      payouts.push({ target, amount });
    }
  }
  if (payouts.length === 0) {
    return refuse('no_payable_payout', 'This product cannot be paid here');
  }
  return {
    ok: true,
    offer,
    productAddress: productAddress(offer.product),
    payouts,
    confirm: offer.warnings.filter((warning) => CONFIRM_WARNINGS.includes(warning)),
    notices: offer.warnings.filter((warning) => !CONFIRM_WARNINGS.includes(warning)),
    hints,
    relays,
    snapshotAt: now,
  };
}
