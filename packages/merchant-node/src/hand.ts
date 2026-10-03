/**
 * Answering an order by hand: the owner's remedy when "contact the store" is
 * the buyer's only way forward (a payment the node refused, a transaction that
 * reverted, a late approval). The rules are pure, so the CLI only sequences them:
 * the close is saved first, then the answer is published.
 */
import {
  type WrappedOrderMessage,
  buildOrderMessage,
  parseCaip19,
  wrapOrderMessage,
} from '@elisym/commerce';
import { type HandAnswer, type LedgerState, markTempo } from './ledger';
import type { Delivery } from './reply';
import { isSolanaSignature } from './signature';

export type HandRequest =
  | { kind: 'delivered'; delivery: Delivery }
  | {
      kind: 'refunded';
      tx: string;
      amount: string;
      /** `--asset`: the refunded coin, as CAIP-19. */
      asset?: string;
      /** The configured payouts' assets: the default when there is exactly one. */
      payoutAssets: readonly string[];
    };

export type HandPlan =
  | {
      ok: true;
      /** The answer to send: the stored one on a rerun. */
      answer: HandAnswer;
      buyerPubkey: string;
      orderId: string;
      /** A rerun of an answer already saved: nothing is written again. */
      rerun: boolean;
      /** Said to the operator before sending. */
      warning?: string;
    }
  | { ok: false; problem: string };

const TEMPO_HASH_RE = /^0x[0-9a-f]{64}$/;
const POSITIVE_SUBUNITS_RE = /^[1-9]\d{0,38}$/;

/** A refund transaction as the ledger spells payments: a Solana signature or a lowercase Tempo hash. */
function isRefundTx(tx: string): boolean {
  return TEMPO_HASH_RE.test(tx) || isSolanaSignature(tx);
}

/**
 * Judge a hand answer for the order `key` (`<buyer>:<orderId>`): an unpaid
 * order still held, or a key closed by the prune or by an earlier hand answer.
 * A paid order is the node's to deliver; an unknown key is refused; an answer
 * already sent is re-sent as stored, and the opposite one is refused (a widget
 * that heard the first is terminal and would drop it).
 */
export function planHandAnswer(state: LedgerState, key: string, request: HandRequest): HandPlan {
  const [buyerPubkey, orderId] = key.split(':');
  if (buyerPubkey === undefined || orderId === undefined || key.split(':').length !== 2) {
    return { ok: false, problem: `${key} is not <buyer>:<orderId>` };
  }
  if (request.kind === 'refunded') {
    if (!isRefundTx(request.tx)) {
      return { ok: false, problem: 'the refund tx is neither a Solana signature nor a Tempo hash' };
    }
    if (!POSITIVE_SUBUNITS_RE.test(request.amount)) {
      return {
        ok: false,
        problem:
          'the refund amount must be subunits above 0 (an unpaid order is released with deliver, never a zero refund)',
      };
    }
  }
  const stored = state.answeredByHand?.[key];
  if (stored !== undefined) {
    if (stored.kind !== request.kind) {
      return {
        ok: false,
        problem: `${key} was already answered as ${stored.kind}: the other answer is refused`,
      };
    }
    // A rerun sends what was sent: the default asset never applies, and only an
    // explicit --asset that differs from the stored one is refused.
    if (request.kind === 'refunded' && request.asset !== undefined) {
      if (stored.caip19 === undefined) {
        return {
          ok: true,
          answer: stored,
          buyerPubkey,
          orderId,
          rerun: true,
          warning: `${key} was answered without an asset: it is sent again unchanged, without --asset`,
        };
      }
      if (stored.caip19 !== request.asset) {
        return {
          ok: false,
          problem: `${key} was refunded in ${stored.caip19}: --asset ${request.asset} is refused`,
        };
      }
    }
    return { ok: true, answer: stored, buyerPubkey, orderId, rerun: true };
  }
  const order = state.orders[key];
  if (order === undefined && state.closedOrders?.[key] !== true) {
    return { ok: false, problem: `no order ${key} in the ledger` };
  }
  if (order?.paid !== undefined) {
    return {
      ok: false,
      problem: `${key} is paid: the node delivers it itself (a refund of a delivered order is not handled here)`,
    };
  }
  let asset: string | undefined;
  if (request.kind === 'refunded') {
    const chosen = refundAsset(request);
    if (!chosen.ok) {
      return chosen;
    }
    asset = chosen.asset;
  }
  const answer: HandAnswer = {
    kind: request.kind,
    ...(request.kind === 'delivered'
      ? { delivery: { ...request.delivery } }
      : {
          tx: request.tx,
          amount: request.amount,
          ...(asset === undefined ? {} : { caip19: asset }),
        }),
    reportedTxs: [...(order?.reportedTxs ?? [])],
    refusedTxs: [...(order?.refusedTxs ?? [])],
    noLegTxs: [...(order?.noLegTxs ?? [])],
  };
  return { ok: true, answer, buyerPubkey, orderId, rerun: false };
}

/**
 * The asset of a new refund: `--asset`, else the only configured payout. It must
 * be a coin the registry knows (a refund may be in one since removed from the
 * config), and the refund tx must be of its chain.
 */
function refundAsset(
  request: Extract<HandRequest, { kind: 'refunded' }>,
): { ok: true; asset: string } | { ok: false; problem: string } {
  const [only, ...others] = request.payoutAssets;
  const asset = request.asset ?? (others.length === 0 ? only : undefined);
  if (asset === undefined) {
    return {
      ok: false,
      problem: 'the store has several payouts: pass --asset <caip19> for the coin refunded',
    };
  }
  const parsed = parseCaip19(asset);
  if (parsed === undefined) {
    return { ok: false, problem: `--asset ${asset} is not an asset this node knows` };
  }
  const ofChain =
    parsed.chain.family === 'evm' ? TEMPO_HASH_RE.test(request.tx) : isSolanaSignature(request.tx);
  if (!ofChain) {
    return {
      ok: false,
      problem: `the refund tx is not a ${parsed.chain.family === 'evm' ? 'Tempo' : 'Solana'} transaction, as ${asset} needs`,
    };
  }
  return { ok: true, asset };
}

/**
 * Close the order in the ledger: gone from `orders` (with everything kept on it),
 * its key closed - never credited, never reusable, also by a node older than
 * this command - and the answer kept as sent.
 */
export function applyHandAnswer(state: LedgerState, key: string, answer: HandAnswer): void {
  delete state.orders[key];
  (state.closedOrders ??= {})[key] = true;
  (state.answeredByHand ??= {})[key] = answer;
  if (answer.tx !== undefined && TEMPO_HASH_RE.test(answer.tx)) {
    markTempo(state);
  }
}

/** The signed status of a hand answer: `completed` with the delivery, or `cancelled` with the refund. */
export function buildHandAnswer(
  plan: Extract<HandPlan, { ok: true }>,
  storeSecretKey: Uint8Array,
  createdAt: number,
): WrappedOrderMessage {
  const { answer } = plan;
  if (answer.kind === 'delivered' && answer.delivery === undefined) {
    throw new Error('A hand delivery carries what was delivered');
  }
  const rumor = buildOrderMessage(
    answer.kind === 'delivered'
      ? {
          type: 'status',
          buyerPubkey: plan.buyerPubkey,
          orderId: plan.orderId,
          status: 'completed',
          ...(answer.delivery === undefined ? {} : { delivery: answer.delivery }),
        }
      : {
          type: 'status',
          buyerPubkey: plan.buyerPubkey,
          orderId: plan.orderId,
          status: 'cancelled',
          refund: {
            tx: answer.tx ?? '',
            amount: answer.amount ?? '',
            ...(answer.caip19 === undefined ? {} : { caip19: answer.caip19 }),
          },
        },
    createdAt,
  );
  return wrapOrderMessage(rumor, storeSecretKey, plan.buyerPubkey);
}
