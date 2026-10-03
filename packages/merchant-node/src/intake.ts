import {
  type UnwrappedOrderMessage,
  deriveOrderPaymentReference,
  productAddress,
} from '@elisym/commerce';
import { MAX_RECEIPTS_PER_ORDER } from './constants';
import { type LedgerState, type MerchantOrder, markTempo, recordReport } from './ledger';
import { type StoreRules, isDirectOrder, orderKey, receiptProblem } from './order-rules';

export interface StoreIdentity extends StoreRules {
  /** The one product this store sells in direct mode: `30402:<store>:<d>`. */
  productAddress: string;
}

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

export function storeIdentity(
  storePubkey: string,
  d: string,
  mediums: readonly string[],
): StoreIdentity {
  const address = productAddress({ storePubkey, d });
  return { storePubkey, productAddress: address, productAddresses: new Set([address]), mediums };
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
    const { medium, tx } = message.payment;
    const tempo = medium.startsWith('tempo');
    if (!order.reportedTxs.includes(tx) && order.reportedTxs.length >= MAX_RECEIPTS_PER_ORDER) {
      return { kind: 'ignored', reason: 'too_many_receipts' };
    }
    state.seenRumors[unwrapped.rumorId] = true;
    const isNew = !order.reportedTxs.includes(tx);
    if (isNew) {
      recordReport(order, tx, now);
      if (tempo) {
        markTempo(state);
      }
    }
    return { kind: 'receipt', order, tx, isNew };
  }
  return { kind: 'ignored', reason: 'not_handled' };
}
