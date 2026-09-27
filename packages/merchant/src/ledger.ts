import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import { CATCH_UP_SECS } from './constants';
import type { TermsPeriod } from './terms';

/** A direct-mode order as the merchant holds it. */
export interface MerchantOrder {
  /** `<buyer>:<orderId>`: an order id is the buyer's, so it is unique per buyer. */
  key: string;
  buyerPubkey: string;
  orderId: string;
  /** The order rumor: the same rumor again is a no-op, a different one is dropped. */
  rumorId: string;
  /** The rumor's `created_at`: it positions the payment scan, never the price. */
  createdAt: number;
  /** The Solana reference derived from (store, buyer, orderId). */
  reference: string;
  email?: string;
  /** Transactions the buyer reported (kind 17), at most `MAX_RECEIPTS_PER_ORDER`. */
  reportedTxs: string[];
  /** Reported transactions judged finally NOT a payment for this order: never checked again. */
  refusedTxs?: string[];
  /** Queue position of each reported transaction: when it arrived, then when the sweep last checked it. */
  recheckedAt?: Record<string, number>;
  paid?: {
    signature: string;
    /** Decimal string of subunits the bound transfer paid. */
    amount: string;
    blockTime: number;
    caip19: string;
    medium: string;
  };
  /** Set once the delivery was published. */
  deliveredAt?: number;
}

export interface LedgerState {
  version: 1;
  orders: Record<string, MerchantOrder>;
  /** Every rumor id already read (orders and receipts alike). */
  seenRumors: Record<string, true>;
  /** Keys of unpaid orders pruned after the catch-up window: the id stays used. */
  closedOrders?: Record<string, true>;
  /** Payment signature -> the order it paid: each payment credits one order, once. */
  claims: Record<string, string>;
  /** The store's own terms over time, as it published them. */
  terms: TermsPeriod[];
  /**
   * Seconds: the last moment every inbox relay was read through (stored wraps
   * paged to EOSE, live since). A restart reaches back from here, less the
   * two-day wrap back-dating. Never a wrap's own date: the sender sets that.
   */
  resumeAt?: number;
  /**
   * `<account>:<signature>` -> what a landed transaction on a payout account
   * binds: each is fetched and read once, however many orders are open.
   */
  scans: Record<string, ScannedTransaction>;
  /** The payouts the owner's 10133 lists, and when it was signed: republished unchanged, it keeps its date. */
  payto?: { createdAt: number; payouts: string };
}

export interface ScannedTransaction {
  blockTime: number;
  /** References with a transfer bound to them into the payout (pay-core's binding). */
  references: string[];
}

export function emptyLedger(): LedgerState {
  return { version: 1, orders: {}, seenRumors: {}, claims: {}, terms: [], scans: {} };
}

export function orderKey(buyerPubkey: string, orderId: string): string {
  return `${buyerPubkey}:${orderId}`;
}

/**
 * Claim `signature` for the order `key`: true when it is now (or already was)
 * that order's, false when another order holds it. The claim must be saved
 * before the delivery goes out.
 */
export function claimPayment(state: LedgerState, signature: string, key: string): boolean {
  const holder = state.claims[signature];
  if (holder !== undefined && holder !== key) {
    return false;
  }
  state.claims[signature] = key;
  return true;
}

/** Orders still waiting for a payment, within the catch-up window at `now`. */
export function openOrders(state: LedgerState, now: number, catchUpSecs: number): MerchantOrder[] {
  return Object.values(state.orders).filter(
    (order) => order.paid === undefined && now - order.createdAt <= catchUpSecs,
  );
}

/** Orders paid but not yet delivered: a crash between the two resumes here. */
export function undeliveredOrders(state: LedgerState): MerchantOrder[] {
  return Object.values(state.orders).filter(
    (order) => order.paid !== undefined && order.deliveredAt === undefined,
  );
}

/**
 * Drop unpaid orders past the catch-up window (and a skew allowance): nothing
 * scans for them any more, and anyone can post them for free. Their rumor ids
 * stay, so the same order rumor is still a no-op; paid orders always stay, so a
 * claim can never be re-credited to a recreated order.
 */
export function pruneExpiredOrders(state: LedgerState, now: number): void {
  for (const [key, order] of Object.entries(state.orders)) {
    if (order.paid === undefined && now - order.createdAt > CATCH_UP_SECS + MAX_FUTURE_SKEW_SECS) {
      delete state.orders[key];
      (state.closedOrders ??= {})[key] = true;
    }
  }
}

/**
 * Record a transaction the buyer reported for `order`, with its place in the
 * recheck queue: the time it arrived. The queue then runs first in, first out,
 * so reports arriving later - free to send - never go ahead of it.
 */
export function recordReport(order: MerchantOrder, tx: string, arrivedAt: number): void {
  order.reportedTxs.push(tx);
  order.recheckedAt = { ...order.recheckedAt, [tx]: arrivedAt };
}

export function loadLedger(path: string): LedgerState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyLedger();
  }
  const state = JSON.parse(text) as LedgerState;
  if (state.version !== 1) {
    throw new Error(`Unknown ledger version in ${path}`);
  }
  state.scans ??= {};
  return state;
}

/** Write the whole ledger, atomically: a crash leaves the old file or the new one, never half. */
export function saveLedger(path: string, state: LedgerState): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
