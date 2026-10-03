/**
 * The admin's view of the store's orders, built from the messages its key can
 * read on the inbox relays: the buyers' orders and receipts, and the node's own
 * copies of its answers. Only what the store key sealed is the node's word;
 * everything a buyer sent is a claim, filtered by the node's own rules.
 */
import {
  type Caip19,
  MAX_FUTURE_SKEW_SECS,
  type Money,
  type OrderRequest,
  type OrderStatusMessage,
  type PaymentReceipt,
  type ProductPrice,
  type UnwrappedOrderMessage,
  parseCaip19,
} from '@elisym/commerce';
import { explorerTxUrl } from '@elisym/pay-core';
import Decimal from 'decimal.js-light';
import { MAX_RECEIPTS_PER_ORDER, TERMS_WINDOW_SECS } from '../constants';
import { type StoreRules, isDirectOrder, orderKey, receiptProblem } from '../order-rules';

/** Plain notation for any amount, and room for sums of many 39-digit subunit counts. */
const AmountDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 100 });

/** The store as the admin reads it from its published events. */
export interface AdminStore extends StoreRules {
  /** The current listing of each product address: its price and publication date. */
  listings: ReadonlyMap<string, { price: ProductPrice; createdAt: number }>;
}

export type OrderState = 'ordered' | 'payment_reported' | 'delivered' | 'released' | 'refunded';

/** How the buyer's claimed total compares with the store's current listing. */
export type ClaimCheck =
  /** The listing's price, in its currency. */
  | 'matches'
  /** Another amount or currency than the listing's. */
  | 'differs'
  /** Ordered before the current listing's terms were the only ones honoured. */
  | 'not_checked';

/** An amount the node named, with its asset when the node said which. */
export interface NodeAmount {
  tx: string;
  /** Subunits, a decimal string. */
  amount: string;
  /** The asset, from the status's CAIP-19 id; absent when it named none the registry knows. */
  asset?: Caip19;
  /** The explorer page of `tx` (https only), when the asset names its chain. */
  explorer?: string;
}

export interface Credit extends NodeAmount {
  medium: string;
}

export interface OrderRow {
  key: string;
  buyerPubkey: string;
  orderId: string;
  /** The order rumor's date, else the earliest message about it. */
  createdAt: number;
  /** The buyer's order, when exactly one is loaded. */
  order?: OrderRequest;
  /** Two or more different orders under one buyer and order id. */
  conflict: boolean;
  /** No order is loaded for what was read about this one. */
  orderNotLoaded: boolean;
  claimCheck?: ClaimCheck;
  state: OrderState;
  /** Payments the node credited, once per transaction. */
  credits: Credit[];
  /** Refunds the node answered with, once per transaction. */
  refunds: NodeAmount[];
  /** Transactions the buyer reported that pass the node's receipt rules. */
  reported: { medium: string; tx: string }[];
  /** A receipt in a medium the store does not list (any more). */
  unlistedMedium: boolean;
}

export interface Totals {
  /** Credited per asset, as whole units of the asset. */
  perAsset: { asset: Caip19; subunits: string; amount: string }[];
  /** Credited without an asset the node named: raw subunits per medium. */
  unknownAsset: { medium: string; subunits: string }[];
}

export interface History {
  rows: OrderRow[];
  totals: Totals;
}

interface Dated<T> {
  rumorId: string;
  createdAt: number;
  message: T;
}

interface Group {
  buyerPubkey: string;
  orderId: string;
  orders: Map<string, Dated<OrderRequest>>;
  receipts: Map<string, Dated<PaymentReceipt>>;
  statuses: Map<string, Dated<OrderStatusMessage>>;
}

function groupFor(groups: Map<string, Group>, buyerPubkey: string, orderId: string): Group {
  const key = orderKey(buyerPubkey, orderId);
  let group = groups.get(key);
  if (group === undefined) {
    group = { buyerPubkey, orderId, orders: new Map(), receipts: new Map(), statuses: new Map() };
    groups.set(key, group);
  }
  return group;
}

/**
 * Sort each message under its order, keeping only the authentic ones: a status
 * counts only when the store key sealed it; an order or a receipt only when a
 * buyer (never the store key) sealed it to this store, about this store.
 */
function groupMessages(
  messages: readonly UnwrappedOrderMessage[],
  store: AdminStore,
): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const unwrapped of messages) {
    const { message, senderPubkey, rumorId, createdAt } = unwrapped;
    if (message.type === 'status') {
      if (senderPubkey === store.storePubkey) {
        groupFor(groups, message.buyerPubkey, message.orderId).statuses.set(rumorId, {
          rumorId,
          createdAt,
          message,
        });
      }
      continue;
    }
    if (
      senderPubkey === store.storePubkey ||
      unwrapped.recipientPubkey !== store.storePubkey ||
      (message.type !== 'order' && message.type !== 'receipt') ||
      message.storePubkey !== store.storePubkey
    ) {
      continue;
    }
    if (message.type === 'order') {
      if (isDirectOrder(message, createdAt, store)) {
        groupFor(groups, senderPubkey, message.orderId).orders.set(rumorId, {
          rumorId,
          createdAt,
          message,
        });
      }
    } else {
      groupFor(groups, senderPubkey, message.orderId).receipts.set(rumorId, {
        rumorId,
        createdAt,
        message,
      });
    }
  }
  return groups;
}

function byDate<T>(entries: Iterable<Dated<T>>): Dated<T>[] {
  return [...entries].sort(
    (first, second) =>
      first.createdAt - second.createdAt || (first.rumorId < second.rumorId ? -1 : 1),
  );
}

/** The explorer page of `tx` on the asset's chain: an `https:` link or none. */
function explorerOf(asset: Caip19 | undefined, tx: string): string | undefined {
  if (asset === undefined) {
    return undefined;
  }
  const link = explorerTxUrl(asset.chain, tx);
  return link.startsWith('https://') ? link : undefined;
}

function nodeAmount(tx: string, amount: string, caip19: string | undefined): NodeAmount {
  const asset = caip19 === undefined ? undefined : parseCaip19(caip19);
  const explorer = explorerOf(asset, tx);
  return {
    tx,
    amount,
    ...(asset === undefined ? {} : { asset }),
    ...(explorer === undefined ? {} : { explorer }),
  };
}

/**
 * Compare the buyer's claimed total with the current listing - only for an order
 * placed after the node stopped honouring any earlier terms: a widget opened
 * before a reprice orders at the old price, and the admin cannot see old prices.
 */
export function claimCheck(
  total: Money,
  orderedAt: number,
  listing: { price: ProductPrice; createdAt: number } | undefined,
): ClaimCheck {
  if (
    listing === undefined ||
    orderedAt < listing.createdAt + TERMS_WINDOW_SECS + MAX_FUTURE_SKEW_SECS
  ) {
    return 'not_checked';
  }
  return total.currency === listing.price.currency &&
    new AmountDecimal(total.amount).eq(new AmountDecimal(listing.price.amount))
    ? 'matches'
    : 'differs';
}

/** The row of one order, or `undefined` when nothing about it passed the rules. */
function rowOf(key: string, group: Group, store: AdminStore): OrderRow | undefined {
  const orders = byDate(group.orders.values());
  const first = orders[0];
  const order = orders.length === 1 ? first?.message : undefined;

  const reported: OrderRow['reported'] = [];
  let unlistedMedium = false;
  for (const receipt of byDate(group.receipts.values())) {
    const problem = receiptProblem(receipt.message, group, store);
    if (problem === 'unlisted_medium') {
      unlistedMedium = true;
    }
    const { medium, tx } = receipt.message.payment;
    if (
      problem === undefined &&
      !reported.some((entry) => entry.tx === tx) &&
      reported.length < MAX_RECEIPTS_PER_ORDER
    ) {
      reported.push({ medium, tx });
    }
  }

  // The node sends one answer again and again with new dates: one per transaction.
  const credits = new Map<string, Credit>();
  const refunds = new Map<string, NodeAmount>();
  let released = false;
  for (const { message } of byDate(group.statuses.values())) {
    if (message.status === 'completed' && message.receipt !== undefined) {
      const { medium, tx, amount, caip19 } = message.receipt;
      const earlier = credits.get(tx);
      if (earlier === undefined || (earlier.asset === undefined && caip19 !== undefined)) {
        credits.set(tx, { medium, ...nodeAmount(tx, amount, caip19) });
      }
    } else if (message.status === 'completed') {
      released = true;
    } else if (message.status === 'cancelled' && message.refund !== undefined) {
      const { tx, amount, caip19 } = message.refund;
      const earlier = refunds.get(tx);
      if (earlier === undefined || (earlier.asset === undefined && caip19 !== undefined)) {
        refunds.set(tx, nodeAmount(tx, amount, caip19));
      }
    }
  }

  if (orders.length === 0 && group.statuses.size === 0 && reported.length === 0) {
    return undefined;
  }

  let state: OrderState = 'ordered';
  if (credits.size > 0) {
    state = 'delivered';
  } else if (refunds.size > 0) {
    state = 'refunded';
  } else if (released) {
    state = 'released';
  } else if (reported.length > 0) {
    state = 'payment_reported';
  }

  const dates = [...group.receipts.values(), ...group.statuses.values()].map(
    (entry) => entry.createdAt,
  );
  const createdAt = first?.createdAt ?? Math.min(...dates);
  const item = order?.items[0];
  return {
    key,
    buyerPubkey: group.buyerPubkey,
    orderId: group.orderId,
    createdAt,
    ...(order === undefined ? {} : { order }),
    conflict: orders.length > 1,
    orderNotLoaded: orders.length === 0,
    ...(order === undefined || item === undefined
      ? {}
      : { claimCheck: claimCheck(order.total, createdAt, store.listings.get(item.product)) }),
    state,
    credits: [...credits.values()],
    refunds: [...refunds.values()],
    reported,
    unlistedMedium,
  };
}

/** Subunits of `asset` as whole units, in plain notation. */
export function wholeUnits(subunits: string, asset: Caip19): string {
  return new AmountDecimal(subunits)
    .div(new AmountDecimal(10).pow(asset.asset.decimals))
    .toString();
}

/** Credited amounts summed per asset, each payment once, from the node's statuses only. */
export function totalsOf(rows: readonly OrderRow[]): Totals {
  const counted = new Set<string>();
  const perAsset = new Map<string, { asset: Caip19; sum: Decimal }>();
  const unknownAsset = new Map<string, Decimal>();
  for (const row of rows) {
    for (const credit of row.credits) {
      const id = `${credit.medium}|${credit.tx}`;
      if (counted.has(id)) {
        continue;
      }
      counted.add(id);
      const amount = new AmountDecimal(credit.amount);
      if (credit.asset === undefined) {
        unknownAsset.set(
          credit.medium,
          (unknownAsset.get(credit.medium) ?? new AmountDecimal(0)).plus(amount),
        );
        continue;
      }
      const entry = perAsset.get(credit.asset.id);
      if (entry === undefined) {
        perAsset.set(credit.asset.id, { asset: credit.asset, sum: amount });
      } else {
        entry.sum = entry.sum.plus(amount);
      }
    }
  }
  return {
    perAsset: [...perAsset.values()].map(({ asset, sum }) => ({
      asset,
      subunits: sum.toString(),
      amount: wholeUnits(sum.toString(), asset),
    })),
    unknownAsset: [...unknownAsset.entries()].map(([medium, sum]) => ({
      medium,
      subunits: sum.toString(),
    })),
  };
}

/** The store's orders, newest first, and what the node credited. */
export function buildHistory(
  messages: readonly UnwrappedOrderMessage[],
  store: AdminStore,
): History {
  const rows = [...groupMessages(messages, store).entries()]
    .map(([key, group]) => rowOf(key, group, store))
    .filter((row): row is OrderRow => row !== undefined)
    .sort((first, second) => second.createdAt - first.createdAt);
  return { rows, totals: totalsOf(rows) };
}
