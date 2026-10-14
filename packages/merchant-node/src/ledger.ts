import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import type { Network } from '@elisym/pay-core';
import { CATCH_UP_SECS, WEBHOOK_DEADLINE_SECS } from './constants';
import { replaceFileDurably } from './durable-file';
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
  /** The merchant's own id for the buyer's account, as the order carried it. */
  customerRef?: string;
  /** The product address the order named (`30402:<store>:<d>`): its terms are that product's. */
  product: string;
  /** Transactions the buyer reported (kind 17), at most `MAX_RECEIPTS_PER_ORDER`. */
  reportedTxs: string[];
  /** Reported transactions judged finally NOT a payment for this order: never checked again. */
  refusedTxs?: string[];
  /**
   * Tempo: reported hashes whose receipt showed no leg for this order. Not
   * rechecked by the sweep (a report of someone else's hash costs one read), but
   * a catch-up memo match lifts one: a receipt read and a log scan may be
   * answered by different backends.
   */
  noLegTxs?: string[];
  /** Tempo: catch-up matches whose verify said N for every term the leg could pay: not verified again. */
  tempoNoLeg?: string[];
  /** Tempo: a transfer to the payout that the recipient's policy blocked (the money sits with the guard). */
  blockedTx?: string;
  /** Queue position of each reported transaction: when it arrived, then when the sweep last checked it. */
  recheckedAt?: Record<string, number>;
  /**
   * Transactions that paid this order at least the floor, the rest to an
   * address that is no elisym treasury this node knows (paid rule 3), and when
   * each was first seen so. Neither paid nor refused: a later treasury read may
   * resolve them. Cleared when the order is paid or answered by hand, and
   * per transaction once it is set aside for good (`clearFeeUnresolved`).
   */
  feeUnresolved?: Record<string, number>;
  paid?: VerifiedPayment;
  /** The `order.paid` webhook, written in the same save as `paid` (see `recordPayment`). */
  webhook?: WebhookEntry;
  /** Inbox relays that took the completed status so far (persisted name): a retry goes to the others only. */
  deliveredTo?: string[];
  /** Set once the completed status counts as sent (see `deliveryDone`; persisted name). */
  deliveredAt?: number;
}

/** A payment the node verified on chain for one order. */
export interface VerifiedPayment {
  signature: string;
  /** Decimal string of subunits paid in total: the merchant's part and the protocol fee. */
  amount: string;
  /**
   * Decimal string of subunits of `amount` that went to an elisym treasury (the
   * protocol fee): the merchant's wallet received `amount - fee`. Absent in a
   * payment recorded by a node before protocol-fee support: read it as '0'.
   */
  fee?: string;
  blockTime: number;
  caip19: string;
  medium: string;
}

/** One order's `order.paid` webhook: an outbox entry, sent until a 2xx or its deadline. */
export interface WebhookEntry {
  state: 'pending' | 'sent' | 'failed';
  /** See `webhookEventId`: the same for every send of this payment. */
  eventId: string;
  /** When the entry was written (or written again by `webhook retry` / `resend`). */
  createdAt: number;
  /** Past this, a pending entry fails instead of being sent. */
  deadline: number;
  attempts: number;
  /** The earliest moment of the next attempt. */
  nextAt: number;
  /** The HTTP status of the last attempt that got an answer. */
  lastStatus?: number;
  /** Why the last attempt failed, short and printable. */
  lastError?: string;
  sentAt?: number;
}

/** Where a payment verified while a webhook is configured is queued: the store, and the clock. */
export interface WebhookOutbox {
  storePubkey: string;
  now: () => number;
}

/**
 * The webhook event id of a payment: hex sha256 of `<store>:<order key>:<payment
 * signature>`. A frozen contract (receivers dedupe on it): a resend or a reloaded
 * ledger gives the same id, and two orders paid by one transaction differ by key.
 */
export function webhookEventId(storePubkey: string, key: string, signature: string): string {
  return createHash('sha256').update(`${storePubkey}:${key}:${signature}`, 'utf8').digest('hex');
}

/** A pending webhook entry for a paid order, due now. */
export function newWebhookEntry(
  storePubkey: string,
  order: MerchantOrder,
  now: number,
): WebhookEntry {
  if (order.paid === undefined) {
    throw new Error(`${order.key} is not paid: no webhook`);
  }
  return {
    state: 'pending',
    eventId: webhookEventId(storePubkey, order.key, order.paid.signature),
    createdAt: now,
    deadline: now + WEBHOOK_DEADLINE_SECS,
    attempts: 0,
    nextAt: now,
  };
}

/**
 * Record a verified payment on its order and, with a webhook configured, its
 * outbox entry in the same change: the one save that records the payment
 * records the entry, so a crash can never keep one without the other.
 */
export function recordPayment(
  order: MerchantOrder,
  paid: VerifiedPayment,
  outbox: WebhookOutbox | undefined,
): void {
  order.paid = paid;
  delete order.feeUnresolved;
  if (outbox !== undefined) {
    order.webhook = newWebhookEntry(outbox.storePubkey, order, outbox.now());
  }
}

/** The answer the owner sent by hand for an order, exactly as sent (a rerun sends it again). */
export interface HandAnswer {
  /** `delivered` is the stored token of a `complete` (persisted name, never renamed). */
  kind: 'delivered' | 'refunded';
  tx?: string;
  amount?: string;
  /** The refunded asset: absent in an answer kept by a node older than 0.4.0. */
  caip19?: string;
  /** The order's customer reference: a hand answer sends no webhook, so the owner credits it. */
  customerRef?: string;
  /** What the ledger held for the order when it was closed. */
  reportedTxs: string[];
  refusedTxs: string[];
  noLegTxs: string[];
}

/** The last listing of a product that went out: what setup compares against to publish only changes. */
export interface PublishedListing {
  /** See `listingHash`: the listing's content, never its date. */
  hash: string;
  eventId: string;
  createdAt: number;
}

/**
 * The only ledger version this node writes. 4 arrived with protocol-fee
 * support: every older node refuses it ("Unknown ledger version"), so no node
 * that would refuse a fee-split payment can ever run on a home whose store
 * declared fee support.
 */
export const LEDGER_VERSION = 4;

/** The version before protocol-fee support: `setup` and `run` convert it, nothing else opens it. */
export const PRE_FEE_LEDGER_VERSION = 3;

/** Why a command other than `setup` / `run` refuses a ledger of the version before fee support. */
export const UPGRADE_FIRST_PROBLEM =
  'this home was last run by a version before protocol-fee support: run `elisym-merchant setup` or `run` once after upgrading';

/** Why a home made by merchant-node 0.7 or earlier is refused. */
export const OLD_HOME_PROBLEM =
  'this home was made by merchant-node 0.7 or earlier: create a new home with init';

/** The elisym treasuries one network's protocol config named, and when it last did. */
export interface KnownTreasuries {
  /** Solana treasury (base58) -> the last moment a fresh config read named it. */
  solana: Record<string, number>;
  /** EVM (Tempo) treasury (lowercase 0x) -> the last moment a fresh config read named it. */
  evm: Record<string, number>;
  /** What the last successful read named: kept whatever its age (an outage never empties the set). */
  latest?: { solana: string; evm?: string };
}

/** A transaction of a rule-3 order that was closed unanswered: the owner may still answer it by hand. */
export interface UnresolvedPayment {
  key: string;
  tx: string;
  /** When the transaction was first seen unresolved. */
  at: number;
}

export interface LedgerState {
  version: typeof LEDGER_VERSION;
  orders: Record<string, MerchantOrder>;
  /** Every rumor id already read (orders and receipts alike). */
  seenRumors: Record<string, true>;
  /** Keys of unpaid orders pruned after the catch-up window, or answered by hand: the id stays used. */
  closedOrders?: Record<string, true>;
  /** Orders the owner answered by hand (`complete` / `refund`). */
  answeredByHand?: Record<string, HandAnswer>;
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
  /**
   * The last listing of each product that went out, by `d`: its keys are every
   * product ever published, whose directory may never be deleted.
   */
  listings: Record<string, PublishedListing>;
  /** The payouts the owner's 10133 lists, and when it was signed: republished unchanged, it keeps its date. */
  payto?: { createdAt: number; payouts: string };
  /** The elisym treasuries each network's config named (only fresh, genesis-checked reads write them). */
  treasuries: Partial<Record<Network, KnownTreasuries>>;
  /** Payments of rule-3 orders closed without an answer (see `pruneExpiredOrders`). */
  unresolvedPayments: UnresolvedPayment[];
}

export interface ScannedTransaction {
  blockTime: number;
  /** References with a transfer bound to them into the payout (pay-core's binding). */
  references: string[];
}

export function emptyLedger(): LedgerState {
  return {
    version: LEDGER_VERSION,
    orders: {},
    seenRumors: {},
    claims: {},
    terms: [],
    scans: {},
    listings: {},
    treasuries: {},
    unresolvedPayments: [],
  };
}

/**
 * Claim `signature` for the order `key`: true when it is now (or already was)
 * that order's, false when another order holds it. The claim must be saved
 * before the completed status goes out.
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

/** Orders paid but not yet completed: a crash between the two resumes here. */
export function undeliveredOrders(state: LedgerState): MerchantOrder[] {
  return Object.values(state.orders).filter(
    (order) => order.paid !== undefined && order.deliveredAt === undefined,
  );
}

/**
 * Drop unpaid orders past the catch-up window (and a skew allowance): nothing
 * scans for them any more, and anyone can post them for free. Their rumor ids
 * stay, so the same order rumor is still a no-op; paid orders always stay, so a
 * claim can never be re-credited to a recreated order. The unresolved payments
 * of a closed rule-3 order are kept in `unresolvedPayments` (the owner may
 * still answer it by hand) and returned, for the log.
 */
export function pruneExpiredOrders(state: LedgerState, now: number): UnresolvedPayment[] {
  const kept: UnresolvedPayment[] = [];
  for (const [key, order] of Object.entries(state.orders)) {
    if (order.paid === undefined && now - order.createdAt > CATCH_UP_SECS + MAX_FUTURE_SKEW_SECS) {
      for (const [tx, at] of Object.entries(order.feeUnresolved ?? {})) {
        kept.push({ key, tx, at });
      }
      delete state.orders[key];
      (state.closedOrders ??= {})[key] = true;
    }
  }
  state.unresolvedPayments.push(...kept);
  return kept;
}

/**
 * Note that `tx` left `order` unresolved (paid rule 3). True when it is new
 * for the order: only then is it logged.
 */
export function markFeeUnresolved(order: MerchantOrder, tx: string, at: number): boolean {
  if (order.feeUnresolved?.[tx] !== undefined) {
    return false;
  }
  order.feeUnresolved = { ...order.feeUnresolved, [tx]: at };
  return true;
}

/**
 * Forget that `tx` left `order` unresolved: it was set aside for good
 * (refused, or found with no leg for the order) and will never be credited, so
 * it is no unresolved payment any more. The record goes once it is empty.
 */
export function clearFeeUnresolved(order: MerchantOrder, tx: string): void {
  if (order.feeUnresolved?.[tx] === undefined) {
    return;
  }
  const rest = { ...order.feeUnresolved };
  delete rest[tx];
  if (Object.keys(rest).length === 0) {
    delete order.feeUnresolved;
  } else {
    order.feeUnresolved = rest;
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

/**
 * A ledger as read: always in this version's shape, and `read` says what the
 * disk held - this version, the one before fee support (converted in memory,
 * not yet saved), or nothing at all (a first run).
 */
export interface LoadedLedger {
  state: LedgerState;
  read: typeof LEDGER_VERSION | typeof PRE_FEE_LEDGER_VERSION | 'missing';
}

export function loadLedger(path: string): LoadedLedger {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Only a missing file is a first run. Any other read error (permissions, a
    // directory, I/O) must stop the node: an empty ledger saved over the real one
    // would forget every claim, and a payment could be credited twice.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { state: emptyLedger(), read: 'missing' };
    }
    throw error;
  }
  const state = JSON.parse(text) as LedgerState;
  const version: unknown = state.version;
  if (version === 1 || version === 2) {
    throw new Error(`${path}: ${OLD_HOME_PROBLEM}`);
  }
  if (version !== LEDGER_VERSION && version !== PRE_FEE_LEDGER_VERSION) {
    throw new Error(`Unknown ledger version in ${path}`);
  }
  // A ledger before fee support never saw a split payment (only a fee-aware
  // setup declares the store's support, and it saves this version first): the
  // conversion only sets the version and the new fields' empty defaults.
  state.version = LEDGER_VERSION;
  state.scans ??= {};
  state.listings ??= {};
  state.treasuries ??= {};
  state.unresolvedPayments ??= [];
  return { state, read: version };
}

/**
 * The ledger `setup` and `run` work on: read, passed to `refuse` (which throws
 * to stop with nothing written), then converted to this version and SAVED at
 * once when the disk held an older one or none - before any relay or chain is
 * contacted, so an older node refuses the home before this one can declare
 * fee support.
 */
export function openLedgerForUpgrade(
  path: string,
  refuse: (state: LedgerState) => void,
): LedgerState {
  const { state, read } = loadLedger(path);
  refuse(state);
  if (read !== LEDGER_VERSION) {
    saveLedger(path, state);
  }
  return state;
}

/** The ledger every other command works on: one before fee support is refused with the hint. */
export function openLedger(path: string): LedgerState {
  const { state, read } = loadLedger(path);
  if (read === PRE_FEE_LEDGER_VERSION) {
    throw new Error(`${path}: ${UPGRADE_FIRST_PROBLEM}`);
  }
  return state;
}

/** Write the whole ledger, atomically: a crash leaves the old file or the new one, never half. */
export function saveLedger(path: string, state: LedgerState): void {
  replaceFileDurably(path, `${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
}
