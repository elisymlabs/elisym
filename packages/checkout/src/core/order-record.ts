import type { VerifiedOffer } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';

/**
 * Where one order stands. The order is sent and acknowledged BEFORE any wallet
 * opens (`created` -> `ordered`); a payment attempt holds a marker (`paying`);
 * a payment found on chain waits for the store (`paid`).
 */
export type OrderState =
  /** Written, the order not yet acknowledged by the store's inbox relays. */
  | 'created'
  /** Acknowledged; no payment attempt holds a marker. */
  | 'ordered'
  /** A payment attempt holds the marker. */
  | 'paying'
  /** The payment was found on chain; waiting for the store's status. */
  | 'paid'
  /** The store delivered. */
  | 'completed'
  /** The store cancelled with a refund. */
  | 'refunded'
  /** No payment by the deadline: a new order may start (it is still reconciled). */
  | 'ended-unpaid'
  /** Tempo: the money sits with the recipient's transfer policy guard. */
  | 'blocked';

export type PaymentMarker =
  | {
      rail: 'solana';
      /** Random per attempt: every clear or replace is a compare-and-swap on it. */
      attemptId: string;
      setAt: number;
      /** The blockhash the widget set; the widget broadcasts only a message with this lifetime. */
      blockhash: string;
      /** Decimal string: the attempt is over once `finalized` passes this height. */
      lastValidBlockHeight: string;
      /** The signature of the transaction the wallet signed, once known. */
      signature?: string;
    }
  | {
      rail: 'tempo';
      attemptId: string;
      setAt: number;
      /** Decimal string: the finalized block read before the wallet call. */
      floorBlock: string;
      /** The hash the wallet returned. */
      txHash?: string;
      /** A bundle id (`wallet_sendCalls`): approved, the hash comes later. */
      bundleId?: string;
    };

export interface OrderStatus {
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  /** When the widget accepted it (seconds). */
  at: number;
  delivery?: string;
  refunded?: boolean;
}

export interface OrderRecord {
  orderId: string;
  /** `30402:<store>:<d>`: records are indexed by it, never by the naddr string. */
  productAddress: string;
  storePubkey: string;
  /** The one-time buyer key for this order (hex). */
  buyerSecretKey: string;
  buyerPubkey: string;
  /** The order rumor's `created_at` (chain time, seconds). */
  createdAt: number;
  /** Bumped on every write: a writer states the version it judged. */
  version: number;
  state: OrderState;
  payout: { caip19: string; address: string };
  /** Decimal string of subunits. */
  amount: string;
  /** The receipt's `medium`: `solana`, `solana-devnet`, `tempo`, `tempo-moderato`. */
  medium: string;
  /** The derived payment reference (base58) or memo (0x hex). */
  reference: string;
  /** The verified offer the order was placed against. */
  offer: VerifiedOffer;
  /** The composed payment request, written once before the first marker. */
  paymentRequest?: string;
  /** Signed wraps, republished byte for byte on resume. */
  orderWrap?: NostrEvent;
  receiptWrap?: NostrEvent;
  /** The store inbox relays the order went to. */
  inboxRelays: string[];
  /** Relays that answered OK to the order wrap. */
  acknowledgedRelays: string[];
  marker?: PaymentMarker;
  /** The transaction that paid, once found. */
  paidTx?: string;
  status?: OrderStatus;
}

export const TERMINAL_STATES: readonly OrderState[] = ['completed', 'refunded'];

export function isTerminal(record: Pick<OrderRecord, 'state'>): boolean {
  return TERMINAL_STATES.includes(record.state);
}

/**
 * Whether the record keeps any other order for the same product from paying: a
 * set marker until the attempt provably ended (`ended-unpaid`, or `blocked` on
 * Tempo), and a found payment until the store answers. "No stored signature" is
 * never "never sent" on its own.
 */
export function holdsPayExclusion(
  record: Pick<OrderRecord, 'state' | 'marker' | 'paidTx'>,
): boolean {
  if (isTerminal(record)) {
    return false;
  }
  // A found payment holds it until the store answers, whatever the state says.
  if (record.state === 'paid' || record.paidTx !== undefined) {
    return true;
  }
  if (record.state === 'ended-unpaid' || record.state === 'blocked') {
    return false;
  }
  return record.marker !== undefined;
}

/** A payment was found, or the store has answered. */
function hasOutcome(record: OrderRecord): boolean {
  return (
    record.state === 'paid' ||
    record.state === 'completed' ||
    record.state === 'refunded' ||
    record.status !== undefined
  );
}

function newer(left: OrderRecord, right: OrderRecord): OrderRecord {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt > right.createdAt ? left : right;
  }
  return left.orderId < right.orderId ? left : right;
}

/**
 * The record the widget shows for a product: one whose payment was found or
 * which has a status comes ahead of any newer unpaid one; otherwise the newest.
 */
export function recordToShow(records: readonly OrderRecord[]): OrderRecord | undefined {
  const withOutcome = records.filter(hasOutcome);
  const pool = withOutcome.length > 0 ? withOutcome : records;
  let shown: OrderRecord | undefined;
  for (const record of pool) {
    shown = shown === undefined ? record : newer(shown, record);
  }
  return shown;
}
