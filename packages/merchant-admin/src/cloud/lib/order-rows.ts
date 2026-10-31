/**
 * The cloud's orders as the admin's own rows (plan `admin-unified.md` 2.5), so
 * the dashboard's totals and charts are the self-hosted overview's. A paid
 * order has its one credit: `delivered` once completed, `payment_reported`
 * while its completion is not out (the money arrived; the orders list keeps
 * the cloud's own pill); an unpaid one is `ordered`; closed orders (keys
 * only, no date) are not rows.
 */
import { parseCaip19 } from '@elisym/commerce';
import { explorerTxUrl } from '@elisym/pay-core';
import type { Credit, OrderRow } from '../../lib/core';
import type { OrderPaymentRead, OrderRead } from './orders';

function creditOf(payment: OrderPaymentRead): Credit {
  const asset = parseCaip19(payment.asset);
  const link = asset === undefined ? undefined : explorerTxUrl(asset.chain, payment.signature);
  return {
    tx: payment.signature,
    amount: payment.amount,
    fee: payment.fee,
    medium: payment.medium,
    ...(asset === undefined ? {} : { asset }),
    ...(link?.startsWith('https://') === true ? { explorer: link } : {}),
  };
}

function stateOf(order: OrderRead): OrderRow['state'] {
  if (order.payment === null) {
    return 'ordered';
  }
  return order.deliveredAt === null ? 'payment_reported' : 'delivered';
}

export function orderRowOf(order: OrderRead): OrderRow {
  return {
    key: order.key,
    buyerPubkey: order.buyer,
    orderId: order.orderId,
    createdAt: order.createdAt,
    product: order.product,
    conflict: false,
    orderNotLoaded: false,
    state: stateOf(order),
    credits: order.payment === null ? [] : [creditOf(order.payment)],
    refunds: [],
    reported: [],
    unlistedMedium: false,
  };
}

export function orderRowsOf(orders: readonly OrderRead[]): OrderRow[] {
  return orders.map(orderRowOf);
}
