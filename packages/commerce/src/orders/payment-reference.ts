import { markTempoCommerceMemo } from '@elisym/pay-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, hex } from '@scure/base';
import { ORDER_PAYMENT_REFERENCE_PREFIX } from '../constants';
import { HEX_PUBKEY_RE } from '../tags';
import { isOrderId } from './messages';

const UTF8 = new TextEncoder();

export interface OrderPaymentReferenceInput {
  /** The store the order is placed with (its store key, hex). */
  storePubkey: string;
  /** The buyer's key, hex: the authenticated sender of the order's gift wrap. */
  buyerPubkey: string;
  /** Random, at least 122 bits (a UUIDv4): it is what keeps the public reference private. */
  orderId: string;
}

/** The one value that ties a payment to one order, spelled for each rail. */
export interface OrderPaymentReference {
  /** Solana: the reference key the transfer carries, base58. */
  solana: string;
  /** Tempo: the `transferWithMemo` memo, 32 bytes of lowercase hex. */
  tempo: string;
  /**
   * Tempo, marked: the commerce magic `0xfab22e7e`, then the first 28 bytes of
   * `tempo`. Paid only to a store whose profile declares `['memo-marker', '1']`,
   * whose node accepts both forms; it makes the payment countable as an elisym
   * purchase from public chain data, and binds the order with 224 bits.
   */
  tempoMarked: string;
  /**
   * USDC over EIP-3009 (Ethereum, Arbitrum, Base): the authorization's 32-byte
   * nonce, always the marked form (`tempoMarked`, the same bytes) - a new rail
   * has no legacy node to stay compatible with.
   */
  eip3009: string;
}

/**
 * The payment reference of an order, derived from the order itself.
 *
 * On chain, a reference (Solana) or a memo (Tempo) is the only thing that binds
 * a transfer to one order, and a check by transaction hash does not ask when
 * the transfer happened. A reference the buyer merely NAMES could be copied
 * from any transfer the payout address ever received and credit a new order
 * with it. Derived here - a hash over the store, the buyer and the order id -
 * it is known to both sides without the merchant being online, and no one can
 * find an existing transfer that carries it, nor steer another buyer's payment
 * onto their own order: the buyer key is the authenticated sender of the
 * order, not something the payer can claim.
 *
 * The checkout pays under it; the merchant derives it again from the order it
 * received and refuses a payment under any other. The merchant still claims
 * each payment once and refuses an order id a buyer has already used. It
 * derives with the store key that opened the gift wrap and the wrap's
 * authenticated sender - never with keys the order's tags merely name.
 *
 * The reference is public on chain and a function of public keys, so the
 * order id is what keeps it private: draw it at random, at least 122 bits (a
 * UUIDv4). A guessable id would let anyone check whether a known buyer key -
 * an agent's is persistent - paid a known store.
 */
export function deriveOrderPaymentReference(
  input: OrderPaymentReferenceInput,
): OrderPaymentReference {
  if (!HEX_PUBKEY_RE.test(input.storePubkey) || !HEX_PUBKEY_RE.test(input.buyerPubkey)) {
    throw new Error('storePubkey and buyerPubkey must be 64 lowercase hex characters');
  }
  if (!isOrderId(input.orderId)) {
    throw new Error('Not an order id: 8 to 64 of A-Z, a-z, 0-9 and -');
  }
  const digest = sha256(
    UTF8.encode(
      `${ORDER_PAYMENT_REFERENCE_PREFIX}:${input.storePubkey}:${input.buyerPubkey}:${input.orderId}`,
    ),
  );
  const tempo = `0x${hex.encode(digest)}`;
  const tempoMarked = markTempoCommerceMemo(tempo);
  return { solana: base58.encode(digest), tempo, tempoMarked, eip3009: tempoMarked };
}

/**
 * Every Tempo memo an order may be paid under: the legacy form, then the marked
 * one. A node that declares `['memo-marker', '1']` accepts both, whichever its
 * store profile says today - a buyer fixes the form when it places the order.
 */
export function acceptedTempoMemos(
  reference: Pick<OrderPaymentReference, 'tempo' | 'tempoMarked'>,
): readonly [legacy: string, marked: string] {
  return [reference.tempo, reference.tempoMarked];
}
