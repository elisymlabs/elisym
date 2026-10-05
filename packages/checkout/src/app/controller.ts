import { decodeProductNaddr, productAddress } from '@elisym/commerce';
import { type LoadedOffer, type LoadOfferOptions, loadOffer } from '@elisym/commerce/buyer';
import { recordToShow } from '@elisym/commerce/buyer';
import type { OrderStore } from '@elisym/commerce/buyer';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { Network } from '@elisym/pay-core';
import type { CheckoutParams } from '../embed/protocol';
import type { HandshakeRefusal } from './handshake';
import { ordersForRef } from './ref-scope';
import { REFUSALS } from './ui/text';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

/** Why an offer view refuses a new purchase: the store's refusal, or a stopped product. */
export type RefusedReason = 'offer_refused' | 'sold_out';

/** A refused offer that still has an order of this device to follow, never paid again. */
export interface FollowOnly {
  reason: RefusedReason;
  message: string;
  orderId: string;
}

/** A start still running this long says so: never a refusal, the session keeps going. */
export const SLOW_START_MS = 30_000;

/**
 * Run the session's start; if it is still running after `SLOW_START_MS`, call
 * `onSlow` once - and nothing else. A slow start is a buyer with an earlier
 * order being checked: it is waited for, never refused on a timer.
 */
export async function startWithHint(start: () => Promise<void>, onSlow: () => void): Promise<void> {
  const timer = setTimeout(onSlow, SLOW_START_MS);
  try {
    await start();
  } finally {
    clearTimeout(timer);
  }
}

/** Rails the widget pays on: Solana and Tempo (an EVM chain). */
export const PAYABLE_FAMILIES = ['solana', 'evm'] as const;

export type Screen =
  /** Waiting for the page's hello; no Buy button yet. */
  | { kind: 'waiting' }
  /** The widget will not sell here. */
  | { kind: 'refused'; reason: RefusalReason; message?: string }
  /** `slow`: still loading long after it began (an earlier order is being checked). */
  | { kind: 'loading'; slow?: boolean }
  | { kind: 'offer'; offer: ReadyOffer };

export type RefusalReason =
  | HandshakeRefusal
  /** The fragment names no product. */
  | 'no_product'
  /** IndexedDB is unavailable (private mode, blocked storage): no order may start. */
  | 'no_storage'
  /** `verifyOffer` or the widget's own policy refused the offer. */
  | 'offer_refused'
  /** The store stopped selling the product (its listing is not on sale). */
  | 'sold_out'
  /** Something failed unexpectedly (storage, the network): nothing is offered. */
  | 'failed'
  /** The page passed a customer reference that is not a valid one. */
  | 'bad_customer_ref'
  /**
   * The page passed a customer reference, but the store is not level A on this
   * page's own domain, or the page is not the top window.
   */
  | 'ref_needs_verified_store';

/** The part of `window` the reference check reads. */
export interface FramedWindow {
  parent: unknown;
  top: unknown;
}

/**
 * Why a page's customer reference refuses it before anything is loaded:
 * `undefined` when the page has none, or when it may be honoured once the store
 * proves level A on the page's domain. A reference binds the widget to the
 * store's own page, so that page must be the top window (a scam page framing it
 * would otherwise lend it its address bar).
 */
export function refRefusal(
  params: CheckoutParams,
  frame: FramedWindow,
): 'bad_customer_ref' | 'ref_needs_verified_store' | undefined {
  if (params.badCustomerRef === true) {
    return 'bad_customer_ref';
  }
  if (params.customerRef !== undefined && frame.parent !== frame.top) {
    return 'ref_needs_verified_store';
  }
  return undefined;
}

export interface LoadDeps {
  client: RelayClient;
  /** The order store, or `undefined` when IndexedDB could not be opened. */
  store: OrderStore | undefined;
  /** Replaceable in tests. */
  loadOffer?: (naddr: string, options: LoadOfferOptions) => Promise<LoadedOffer>;
  /** The load that opens the page: it may pass by relays just found dead (`LoadOfferOptions`). */
  skipUnreachable?: boolean;
}

/**
 * The offer verified for the page, with this store's pins from earlier
 * purchases (TOFU: the owner, and every payout that delivered) read fresh each
 * time - the first load and every re-verification before a payment alike, so a
 * re-verification never skips the checks the pins make.
 */
export async function loadWithPins(
  params: CheckoutParams,
  pageOrigin: string,
  deps: LoadDeps & { store: OrderStore },
): Promise<LoadedOffer> {
  const pointer = decodeProductNaddr(params.naddr);
  const pins = pointer === undefined ? undefined : await deps.store.pins(pointer.storePubkey);
  return (deps.loadOffer ?? loadOffer)(params.naddr, {
    client: deps.client,
    pageOrigin,
    families: PAYABLE_FAMILIES,
    ...(params.network === undefined ? {} : { network: params.network as Network }),
    // A reference credits an account: only the store's own verified page may pass one.
    ...(params.strictOrigin || params.customerRef !== undefined ? { strictOrigin: true } : {}),
    ...(deps.skipUnreachable === true ? { skipUnreachable: true } : {}),
    ...(pins === undefined
      ? {}
      : { pins: { pinnedOwnerPubkey: pins.pinnedOwnerPubkey, knownPayouts: pins.knownPayouts } }),
  });
}

/**
 * The screen for a page whose hello was taken: the offer verified for that
 * page's origin, with this store's pins from earlier purchases (TOFU). Without
 * storage nothing can be ordered (the order record is the double-payment guard),
 * so the widget refuses before showing a price.
 */
export async function screenForPage(
  params: CheckoutParams,
  pageOrigin: string,
  deps: LoadDeps,
): Promise<Screen> {
  if (deps.store === undefined) {
    return { kind: 'refused', reason: 'no_storage' };
  }
  const pointer = decodeProductNaddr(params.naddr);
  if (pointer === undefined) {
    return { kind: 'refused', reason: 'no_product' };
  }
  const loaded = await loadWithPins(params, pageOrigin, {
    ...deps,
    store: deps.store,
    skipUnreachable: true,
  });
  // Before the reference gating: visibility is public, so this tells the page nothing.
  if (!loaded.ok && loaded.refusal === 'product_not_on_sale') {
    return { kind: 'refused', reason: 'sold_out' };
  }
  if (params.customerRef !== undefined) {
    // Strict origin refuses any store that is not level A on this page's domain.
    if (
      (!loaded.ok && loaded.refusal === 'origin_mismatch') ||
      (loaded.ok && loaded.offer.level !== 'A')
    ) {
      return { kind: 'refused', reason: 'ref_needs_verified_store' };
    }
  }
  if (!loaded.ok) {
    return { kind: 'refused', reason: 'offer_refused', message: loaded.message };
  }
  return { kind: 'offer', offer: loaded };
}

/** What a page opens on: the offer to sell (maybe follow-only), or a refusal. */
export type PageStart =
  | { kind: 'refused'; screen: Extract<Screen, { kind: 'refused' }> }
  | {
      kind: 'offer';
      offer: ReadyOffer;
      followOnly?: FollowOnly;
      /** Follow-only: the refusal the page is shown (and told) all the same. */
      refusal?: Extract<Screen, { kind: 'refused' }>;
    };

/**
 * The offer for the page, or why not. Refused, a page without a reference
 * still follows an order of this product it has (never paying again); a page
 * with one only shows the refusal: its refusals are terminal, so a hostile page
 * never learns of the visitor's orders by failing the checks on purpose.
 */
export async function openPage(
  params: CheckoutParams,
  pageOrigin: string,
  deps: LoadDeps,
): Promise<PageStart> {
  const screen = await screenForPage(params, pageOrigin, deps);
  if (screen.kind === 'offer') {
    return { kind: 'offer', offer: screen.offer };
  }
  const refused: Extract<Screen, { kind: 'refused' }> =
    screen.kind === 'refused' ? screen : { kind: 'refused', reason: 'failed' };
  if (deps.store === undefined || params.customerRef !== undefined) {
    return { kind: 'refused', screen: refused };
  }
  // A record that cannot be read must not show as a different screen than none.
  const followed = await followOnlyOffer(params.naddr, deps.store, undefined).catch(
    () => undefined,
  );
  if (followed === undefined) {
    return { kind: 'refused', screen: refused };
  }
  return {
    kind: 'offer',
    offer: followed.offer,
    followOnly: {
      reason: refused.reason === 'sold_out' ? 'sold_out' : 'offer_refused',
      message:
        refused.reason === 'sold_out'
          ? REFUSALS.sold_out
          : (refused.message ?? 'This product cannot be bought here.'),
      orderId: followed.orderId,
    },
    refusal: refused,
  };
}

/**
 * When the offer is refused but the product has an order this device must keep
 * following (paying, paid, delivered, refunded, or ended and still heard): an
 * offer built from that order's own snapshot, for a follow-only session - it
 * never pays (the snapshot is stale by construction and the session is told).
 */
export async function followOnlyOffer(
  naddr: string,
  store: OrderStore,
  customerRef: string | undefined,
): Promise<{ offer: ReadyOffer; orderId: string } | undefined> {
  const pointer = decodeProductNaddr(naddr);
  if (pointer === undefined) {
    return undefined;
  }
  const address = productAddress(pointer);
  const records = await ordersForRef(store, address, customerRef);
  const followed = records.filter(
    (record) => record.state !== 'created' && record.state !== 'ordered',
  );
  const shown = recordToShow(followed);
  if (shown === undefined) {
    return undefined;
  }
  const target = shown.offer.payouts.find(
    (payout) => payout.caip19.id === shown.payout.caip19 && payout.address === shown.payout.address,
  );
  if (target === undefined) {
    return undefined;
  }
  return {
    orderId: shown.orderId,
    offer: {
      ok: true,
      offer: shown.offer,
      productAddress: address,
      payouts: [{ target, amount: BigInt(shown.amount) }],
      confirm: [],
      notices: [],
      hints: [],
      relays: [],
      snapshotAt: 0,
    },
  };
}
