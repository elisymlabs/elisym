import {
  type UnwrappedOrderMessage,
  deriveOrderPaymentReference,
  isCustomerRef,
  productAddress,
} from '@elisym/commerce';
import { MAX_RECEIPTS_PER_ORDER } from './constants';
import { type LedgerState, type MerchantOrder, recordReport } from './ledger';
import { type StoreRules, isDirectOrder, orderKey, receiptProblem } from './order-rules';

export type StoreIdentity = StoreRules;

export type IntakeResult =
  | { kind: 'ignored'; reason: IgnoreReason }
  | { kind: 'order'; order: MerchantOrder }
  /** `isNew`: the order had not reported this transaction before. */
  | { kind: 'receipt'; order: MerchantOrder; tx: string; isNew: boolean };

export type IgnoreReason =
  /** Sealed by the store key itself: its own copy of a reply, never an order or a receipt. */
  | 'own_message'
  /** The same rumor again (a resumed widget republishes it byte for byte). */
  | 'seen'
  /** Addressed to another key, or naming another store. */
  | 'not_for_this_store'
  /** Not one item of this store's own product at quantity 1, or dated before any payment could be. */
  | 'not_a_direct_order'
  /** A different order rumor under an order id this buyer already used here: dropped silently. */
  | 'order_id_reused'
  /** A receipt for an order this store does not hold. */
  | 'unknown_order'
  /** A receipt under another reference, on a rail the store does not take, or naming no transaction. */
  | 'foreign_payment'
  /** More receipts for one order than the store keeps. */
  | 'too_many_receipts'
  /** A message type the merchant does not act on (status, payment request). */
  | 'not_handled';

/**
 * The store as intake judges orders: every product it has a directory for,
 * stopped ones included (an order backfilled after a stop still needs its
 * record; what a stopped product accepts is bounded by its retired terms).
 */
export function storeIdentity(
  storePubkey: string,
  ds: readonly string[],
  mediums: readonly string[],
): StoreIdentity {
  return {
    storePubkey,
    productAddresses: new Set(ds.map((d) => productAddress({ storePubkey, d }))),
    mediums,
  };
}

/**
 * Take one unwrapped order message into the ledger. The buyer is the SEAL
 * signer (`senderPubkey`), never the one-time wrap key; the reference is
 * derived here, never taken from the buyer.
 */
export function intake(
  state: LedgerState,
  unwrapped: UnwrappedOrderMessage,
  store: StoreIdentity,
  now: number = Math.floor(Date.now() / 1000),
): IntakeResult {
  // The store's copies of its own replies come back on its inbox: nothing the
  // store key sealed is ever a buyer's order or receipt.
  if (unwrapped.senderPubkey === store.storePubkey) {
    return { kind: 'ignored', reason: 'own_message' };
  }
  if (state.seenRumors[unwrapped.rumorId] === true) {
    return { kind: 'ignored', reason: 'seen' };
  }
  const { message } = unwrapped;
  if (unwrapped.recipientPubkey !== store.storePubkey) {
    return { kind: 'ignored', reason: 'not_for_this_store' };
  }
  if (message.type === 'order') {
    if (message.storePubkey !== store.storePubkey) {
      return { kind: 'ignored', reason: 'not_for_this_store' };
    }
    if (!isDirectOrder(message, unwrapped.createdAt, store)) {
      return { kind: 'ignored', reason: 'not_a_direct_order' };
    }
    const key = orderKey(unwrapped.senderPubkey, message.orderId);
    state.seenRumors[unwrapped.rumorId] = true;
    if (state.orders[key] !== undefined || state.closedOrders?.[key] === true) {
      return { kind: 'ignored', reason: 'order_id_reused' };
    }
    const [item] = message.items;
    // `isDirectOrder` checked it: one item of a product of this store.
    if (item === undefined) {
      return { kind: 'ignored', reason: 'not_a_direct_order' };
    }
    const reference = deriveOrderPaymentReference({
      storePubkey: store.storePubkey,
      buyerPubkey: unwrapped.senderPubkey,
      orderId: message.orderId,
    });
    const order: MerchantOrder = {
      key,
      buyerPubkey: unwrapped.senderPubkey,
      orderId: message.orderId,
      rumorId: unwrapped.rumorId,
      createdAt: unwrapped.createdAt,
      reference: reference.solana,
      reportedTxs: [],
      ...(message.email === undefined ? {} : { email: message.email }),
      product: item.product,
      // Checked again here, though the parser drops a bad one: it reaches the webhook.
      ...(isCustomerRef(message.customerRef) ? { customerRef: message.customerRef } : {}),
    };
    state.orders[key] = order;
    return { kind: 'order', order };
  }
  if (message.type === 'receipt') {
    if (message.storePubkey !== store.storePubkey) {
      return { kind: 'ignored', reason: 'not_for_this_store' };
    }
    const order = state.orders[orderKey(unwrapped.senderPubkey, message.orderId)];
    if (order === undefined) {
      return { kind: 'ignored', reason: 'unknown_order' };
    }
    if (receiptProblem(message, order, store) !== undefined) {
      return { kind: 'ignored', reason: 'foreign_payment' };
    }
    const { tx } = message.payment;
    if (!order.reportedTxs.includes(tx) && order.reportedTxs.length >= MAX_RECEIPTS_PER_ORDER) {
      return { kind: 'ignored', reason: 'too_many_receipts' };
    }
    state.seenRumors[unwrapped.rumorId] = true;
    const isNew = !order.reportedTxs.includes(tx);
    if (isNew) {
      recordReport(order, tx, now);
    }
    return { kind: 'receipt', order, tx, isNew };
  }
  return { kind: 'ignored', reason: 'not_handled' };
}
