import { decodeProductNaddr, productAddress } from '@elisym/commerce';
import { type LoadedOffer, type LoadOfferOptions, loadOffer } from '@elisym/commerce/buyer';
import { recordToShow } from '@elisym/commerce/buyer';
import type { OrderStore } from '@elisym/commerce/buyer';
import type { RelayClient } from '@elisym/commerce/buyer';
import type { Network } from '@elisym/pay-core';
import type { CheckoutParams } from '../embed/protocol';
import type { HandshakeRefusal } from './handshake';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

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
  /** Something failed unexpectedly (storage, the network): nothing is offered. */
  | 'failed';

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
    ...(params.strictOrigin ? { strictOrigin: true } : {}),
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
  if (!loaded.ok) {
    return { kind: 'refused', reason: 'offer_refused', message: loaded.message };
  }
  return { kind: 'offer', offer: loaded };
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
): Promise<{ offer: ReadyOffer; orderId: string } | undefined> {
  const pointer = decodeProductNaddr(naddr);
  if (pointer === undefined) {
    return undefined;
  }
  const address = productAddress(pointer);
  const records = await store.forProduct(address);
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
