/**
 * The rules that decide which buyer messages count, shared by the node's
 * `intake` and the admin page. Pure: no ledger, no network, no Node API, so the
 * admin's browser bundle runs the very same checks as the node.
 */
import {
  type OrderRequest,
  type PaymentReceipt,
  deriveOrderPaymentReference,
} from '@elisym/commerce';
import { EARLIEST_ORDER_SECS } from './constants';
import { isSolanaSignature } from './signature';

/** A Tempo hash as the ledger keeps it: one spelling. */
export const TEMPO_HASH_RE = /^0x[0-9a-f]{64}$/;

/** What the rules need to know about a store. */
export interface StoreRules {
  storePubkey: string;
  /** The products a direct order may name, each `30402:<store>:<d>`. */
  productAddresses: ReadonlySet<string>;
  /** Receipt mediums the store takes, e.g. `solana-devnet`. */
  mediums: readonly string[];
}

/** Why a receipt does not count for its order. */
export type ReceiptProblem =
  /** Not the reference this order's payment carries. */
  | 'wrong_reference'
  /** A rail the store does not take. */
  | 'unlisted_medium'
  /** No transaction in the rail's spelling. */
  | 'bad_tx';

/** One order of a buyer: the buyer's pubkey and their order id. */
export function orderKey(buyerPubkey: string, orderId: string): string {
  return `${buyerPubkey}:${orderId}`;
}

/**
 * Whether an order is one item of a product the store sells, at quantity 1, and
 * dated no earlier than any payment could be: the only orders direct mode takes.
 */
export function isDirectOrder(
  message: OrderRequest,
  createdAt: number,
  store: Pick<StoreRules, 'productAddresses'>,
): boolean {
  const [item, ...rest] = message.items;
  return (
    createdAt >= EARLIEST_ORDER_SECS &&
    item !== undefined &&
    rest.length === 0 &&
    store.productAddresses.has(item.product) &&
    item.quantity === 1
  );
}

/**
 * Why a buyer's receipt does not count for `order`, or `undefined` when it does.
 * The medium names the rail, and the rail decides the reference and the tx
 * spelling: a Tempo receipt carries this order's memo and a lowercase hash. The
 * reference is derived from the order alone, never taken from the buyer.
 */
export function receiptProblem(
  message: PaymentReceipt,
  order: { buyerPubkey: string; orderId: string },
  store: Pick<StoreRules, 'storePubkey' | 'mediums'>,
): ReceiptProblem | undefined {
  const { medium, reference, tx } = message.payment;
  const tempo = medium.startsWith('tempo');
  const derived = deriveOrderPaymentReference({
    storePubkey: store.storePubkey,
    buyerPubkey: order.buyerPubkey,
    orderId: order.orderId,
  });
  if (reference !== (tempo ? derived.tempo : derived.solana)) {
    return 'wrong_reference';
  }
  if (!store.mediums.includes(medium)) {
    return 'unlisted_medium';
  }
  if (!(tempo ? TEMPO_HASH_RE.test(tx) : isSolanaSignature(tx))) {
    return 'bad_tx';
  }
  return undefined;
}

/**
 * The next backfill page after one that returned `received` wraps, the oldest
 * dated `oldest`, or `undefined` when the history down to `since` is read.
 * `until` is inclusive: a page that did not move below `until` (a flood of
 * wraps sharing one second) steps one second down rather than stopping.
 */
export function nextPageUntil(
  since: number,
  until: number,
  received: number,
  oldest: number,
): number | undefined {
  if (received === 0 || oldest <= since) {
    return undefined;
  }
  const next = oldest < until ? oldest : until - 1;
  return next > since ? next : undefined;
}
