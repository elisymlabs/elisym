import {
  type WrappedOrderMessage,
  buildOrderMessage,
  parseCaip19,
  wrapOrderMessage,
} from '@elisym/commerce';
import { DELIVERY_RELAYS_WANTED, DELIVERY_SETTLE_SECS } from './constants';
import type { MerchantOrder } from './ledger';

export interface Delivery {
  method: 'download' | 'license' | 'access' | 'webhook' | 'api';
  /** Shown to the buyer as text, or opened as a link only when it is `https:`. */
  value: string;
}

/**
 * The paid asset as the status names it, or `undefined` for one the registry no
 * longer knows: the asset only labels the receipt, so it never blocks a delivery.
 */
export function creditedAsset(caip19: string): string | undefined {
  return parseCaip19(caip19) === undefined ? undefined : caip19;
}

/**
 * The store's `completed` status for a paid order, sealed by the store key and
 * gift-wrapped to the buyer (the seal signer of the order). It carries the
 * payment the store credited, so the buyer's widget can show what was counted.
 */
export function buildDeliveryReply(
  order: MerchantOrder,
  delivery: Delivery,
  storeSecretKey: Uint8Array,
  createdAt: number,
): WrappedOrderMessage {
  if (order.paid === undefined) {
    throw new Error('Only a paid order is delivered');
  }
  const asset = creditedAsset(order.paid.caip19);
  const rumor = buildOrderMessage(
    {
      type: 'status',
      buyerPubkey: order.buyerPubkey,
      orderId: order.orderId,
      status: 'completed',
      delivery,
      receipt: {
        medium: order.paid.medium,
        tx: order.paid.signature,
        amount: order.paid.amount,
        fee: '0',
        ...(asset === undefined ? {} : { caip19: asset }),
      },
    },
    createdAt,
  );
  return wrapOrderMessage(rumor, storeSecretKey, order.buyerPubkey);
}

/**
 * Whether a delivery that `accepted` of the store's `relays` inbox relays took
 * counts as done: two of them (all, when fewer are configured), since one may
 * drop it later; once the payment is `paidAgeSecs` past `DELIVERY_SETTLE_SECS`,
 * any one - a relay down for good must not keep it pending forever.
 */
export function deliveryDone(accepted: number, relays: number, paidAgeSecs: number): boolean {
  if (accepted === 0) {
    return false;
  }
  return (
    accepted >= Math.min(DELIVERY_RELAYS_WANTED, relays) || paidAgeSecs >= DELIVERY_SETTLE_SECS
  );
}
