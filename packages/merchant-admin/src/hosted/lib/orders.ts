/**
 * The hosted orders, as the merchant reads them (A8): one entry per order the
 * ledger holds, newest first, then the orders answered by hand that the
 * ledger already closed. Every label is fixed by code (A15).
 */
import type { OrderView, OrdersView } from './types';

export type OrderState = 'paid' | 'delivered' | 'answered' | 'unresolved' | 'open';

export const ORDER_STATES: readonly OrderState[] = [
  'open',
  'unresolved',
  'paid',
  'delivered',
  'answered',
];

export const ORDER_STATE_LABELS: Readonly<Record<OrderState, string>> = {
  open: 'open',
  unresolved: 'unresolved payment',
  paid: 'paid',
  delivered: 'delivered',
  answered: 'answered by hand',
};

export type HandAnswered = OrdersView['answeredByHand'][string];
export type UnresolvedPayment = OrdersView['unresolvedPayments'][number];

export interface OrderEntry {
  key: string;
  /** The buyer-chosen order id: the order's, or the part of the key after the buyer. */
  orderId: string;
  buyerPubkey: string;
  /** Absent for an order the ledger closed once it was answered by hand. */
  order?: OrderView;
  state: OrderState;
  hand?: HandAnswered;
  unresolved: UnresolvedPayment[];
}

export type OrderFilter = OrderState | 'all';

const KEY_SEPARATOR = ':';

/** An order key `<buyer pubkey>:<order id>`, split at its first colon (the order id may hold more). */
function splitKey(key: string): { buyerPubkey: string; orderId: string } {
  const at = key.indexOf(KEY_SEPARATOR);
  return at < 0
    ? { buyerPubkey: '', orderId: key }
    : { buyerPubkey: key.slice(0, at), orderId: key.slice(at + 1) };
}

function stateOf(
  order: OrderView | undefined,
  hand: HandAnswered | undefined,
  unresolved: readonly UnresolvedPayment[],
): OrderState {
  if (hand !== undefined) {
    return 'answered';
  }
  if (order?.deliveredAt !== undefined) {
    return 'delivered';
  }
  if (order?.paid !== undefined) {
    return 'paid';
  }
  return unresolved.length > 0 ? 'unresolved' : 'open';
}

/** Every order of the view, newest first, then the closed ones answered by hand. */
export function orderEntries(view: OrdersView): OrderEntry[] {
  const handOf = (key: string) =>
    Object.hasOwn(view.answeredByHand, key) ? view.answeredByHand[key] : undefined;
  const unresolvedOf = (key: string) =>
    view.unresolvedPayments.filter((payment) => payment.key === key);
  const listed = [...view.orders]
    .sort((left, right) => right.createdAt - left.createdAt || (left.key < right.key ? -1 : 1))
    .map((order): OrderEntry => {
      const hand = handOf(order.key);
      const unresolved = unresolvedOf(order.key);
      return {
        key: order.key,
        orderId: order.orderId,
        buyerPubkey: order.buyerPubkey,
        order,
        state: stateOf(order, hand, unresolved),
        ...(hand === undefined ? {} : { hand }),
        unresolved,
      };
    });
  const listedKeys = new Set(view.orders.map((order) => order.key));
  const closed = Object.keys(view.answeredByHand)
    .filter((key) => !listedKeys.has(key))
    .sort()
    .map((key): OrderEntry => {
      const hand = handOf(key);
      return {
        key,
        ...splitKey(key),
        state: 'answered',
        ...(hand === undefined ? {} : { hand }),
        unresolved: unresolvedOf(key),
      };
    });
  return [...listed, ...closed];
}

/** The entries in `filter` whose email, customer ref or order id holds `query` (any case). */
export function visibleEntries(
  entries: readonly OrderEntry[],
  filter: OrderFilter,
  query: string,
): OrderEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter !== 'all' && entry.state !== filter) {
      return false;
    }
    if (needle === '') {
      return true;
    }
    return [entry.orderId, entry.order?.email, entry.order?.customerRef].some(
      (value) => value !== undefined && value.toLowerCase().includes(needle),
    );
  });
}

const WEBHOOK_STATES: Readonly<Record<string, string>> = {
  pending: 'sending (retried until it is taken or its deadline passes)',
  sent: 'sent',
  failed: 'failed (its deadline passed)',
};

/** The paid webhook's state, in fixed words. */
export function webhookText(webhook: NonNullable<OrderView['webhook']>): string {
  const state = Object.hasOwn(WEBHOOK_STATES, webhook.state)
    ? (WEBHOOK_STATES[webhook.state] ?? 'unknown')
    : 'unknown';
  const status = Number.isSafeInteger(webhook.lastStatus)
    ? `, last answer HTTP ${webhook.lastStatus}`
    : '';
  const attempts = Number.isSafeInteger(webhook.attempts) ? webhook.attempts : 0;
  return `${state}; ${attempts} attempt${attempts === 1 ? '' : 's'}${status}`;
}

const HAND_KINDS: Readonly<Record<string, string>> = {
  delivered: 'completed by hand',
  refunded: 'refunded by hand',
};

/** How an order was answered by hand, in fixed words. */
export function handText(hand: HandAnswered): string {
  return (
    (Object.hasOwn(HAND_KINDS, hand.kind) ? HAND_KINDS[hand.kind] : undefined) ?? 'answered by hand'
  );
}

/** A unix time in seconds, as UTC ISO text. */
export function utcText(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
