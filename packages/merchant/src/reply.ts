import { type WrappedOrderMessage, buildOrderMessage, wrapOrderMessage } from '@elisym/commerce';
import type { MerchantOrder } from './ledger';

export interface Delivery {
  method: 'download' | 'license' | 'access' | 'webhook' | 'api';
  /** Shown to the buyer as text, or opened as a link only when it is `https:`. */
  value: string;
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
      },
    },
    createdAt,
  );
  return wrapOrderMessage(rumor, storeSecretKey, order.buyerPubkey);
}
