import { decodeProductNaddr } from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import { type LoadedOffer, type LoadOfferOptions, loadOffer } from '../core/offer';
import type { OrderStore } from '../core/order-store';
import type { RelayClient } from '../core/relay-client';
import type { CheckoutParams } from '../embed/protocol';
import type { HandshakeRefusal } from './handshake';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

/** Rails the widget pays on today: Tempo joins in step 7. */
export const PAYABLE_FAMILIES = ['solana'] as const;

export type Screen =
  /** Waiting for the page's hello; no Buy button yet. */
  | { kind: 'waiting' }
  /** The widget will not sell here. */
  | { kind: 'refused'; reason: RefusalReason; message?: string }
  | { kind: 'loading' }
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
  const pins = await deps.store.pins(pointer.storePubkey);
  const loaded = await (deps.loadOffer ?? loadOffer)(params.naddr, {
    client: deps.client,
    pageOrigin,
    families: PAYABLE_FAMILIES,
    ...(params.network === undefined ? {} : { network: params.network as Network }),
    ...(params.strictOrigin ? { strictOrigin: true } : {}),
    ...(pins === undefined
      ? {}
      : { pins: { pinnedOwnerPubkey: pins.pinnedOwnerPubkey, knownPayouts: pins.knownPayouts } }),
  });
  if (!loaded.ok) {
    return { kind: 'refused', reason: 'offer_refused', message: loaded.message };
  }
  return { kind: 'offer', offer: loaded };
}
