/**
 * Issuing a Tempo payment request - the provider's side of a quote.
 *
 * Everything the request will later be verified against is read from the chain
 * HERE, once, and frozen into the request: the fee and the treasury as they are
 * now, the block the provider's scans may start from, and a memo nobody else can
 * guess. A verification later reads none of it again, so a treasury rotation or
 * a fee switched on midway cannot orphan a request that was already paid.
 *
 * ANY failed read means no request at all. A provider that cannot read the chain
 * must not publish a price on it - a quote is a promise to know the money
 * when it arrives, and it cannot make that promise blind.
 */

import { DEFAULTS } from '../constants';
import type { Asset } from '../payment/assets';
import { assetsFor } from '../payment/assets';
import type { ChainConfig } from '../payment/chains';
import { isEvmWireAddress, isVirtualEvmAddress, normalizeEvmAddress } from '../payment/chains';
import { calculateProtocolFeeSubunits } from '../payment/fee-subunits';
import type { ParsedPaymentRequestV2 } from '../payment/schema-v2';
import { caip19ForAsset, PaymentRequestV2Schema } from '../payment/schema-v2';
import type { Eip1193Client } from './client';
import { assertEvmChain, getEvmProtocolConfig } from './config';
import { readFinalizedBlock } from './logs';
import { canStrangerReceive } from './policy';

const MEMO_BYTES = 32;
/** The v2 schema's own ceiling; named here so the failure says which rule it is. */
const MAX_EXPIRY_SECS = 86_400;

export interface CreateTempoPaymentRequestOptions {
  /** Where the provider wants the money. Never a virtual address. */
  recipient: string;
  /** The TOTAL the customer pays, in the asset's subunits. The fee comes out of it. */
  amount: bigint;
  /** A coin of this chain, from the SDK registry. */
  asset: Asset;
  expirySecs?: number;
  /** Overridable only so that a test can pin it; production reads the clock. */
  nowSecs?: number;
}

export interface TempoPaymentRequestCreation {
  request: ParsedPaymentRequestV2;
  /**
   * The finalized block NUMBER read while issuing. The floor of every scan for
   * this request, and not on the wire: only the issuer needs it, and the caller
   * persists it beside the request.
   */
  fromBlock: number;
}

function randomMemo(): string {
  const bytes = new Uint8Array(MEMO_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build a payment request for `amount` of `asset` to `recipient` on `chain`.
 *
 * The memo is 32 RANDOM bytes, the twin of the Solana reference: it is what
 * binds one transfer to one request. A memo derived from the job id would let a
 * broadcast job's two payments to one address credit each other.
 */
export async function createTempoPaymentRequest(
  client: Eip1193Client,
  chain: ChainConfig,
  options: CreateTempoPaymentRequestOptions,
): Promise<TempoPaymentRequestCreation> {
  const recipient = normalizeEvmAddress(options.recipient);
  if (recipient === undefined || isVirtualEvmAddress(recipient)) {
    throw new Error(`Not an address a payment can be issued to: ${options.recipient}`);
  }
  if (options.amount <= 0n) {
    throw new Error('A payment request needs a positive amount.');
  }
  const expirySecs = options.expirySecs ?? DEFAULTS.PAYMENT_EXPIRY_SECS;
  if (!Number.isInteger(expirySecs) || expirySecs <= 0 || expirySecs > MAX_EXPIRY_SECS) {
    throw new Error(`Invalid expiry: ${expirySecs}. Must be an integer 1-${MAX_EXPIRY_SECS}.`);
  }
  const coin = assetsFor(chain.slug, chain.network).find(
    (candidate) => candidate.mint === options.asset.mint && candidate.token === options.asset.token,
  );
  if (coin?.mint === undefined) {
    throw new Error(`${options.asset.token} is not a coin of ${chain.caip2}.`);
  }
  const token = coin.mint;

  // Fresh, and first: everything below reads state whose meaning depends on
  // WHICH chain answered.
  await assertEvmChain(client, chain);

  const finalized = await readFinalizedBlock(client);
  if (finalized === null) {
    throw new Error(`Could not read the finalized block of ${chain.caip2}.`);
  }

  const config = await getEvmProtocolConfig(client, chain);
  const feeAmount = calculateProtocolFeeSubunits(options.amount, config.feeBps);
  const feeAddress = config.feeBps > 0 ? normalizeEvmAddress(config.treasury) : undefined;
  if (config.feeBps > 0) {
    if (feeAddress === undefined || !isEvmWireAddress(feeAddress)) {
      throw new Error('The protocol config names a treasury that is not an address.');
    }
    // No test can kill this, and it is kept for its message: the v2 schema refuses
    // the same request two lines below, so the only thing this changes is
    // whether the provider is told WHY its own treasury cannot be its payout
    // address.
    if (feeAddress === recipient) {
      throw new Error(
        "The treasury is this provider's own payment address; the fee leg would be a self-transfer.",
      );
    }
    if (feeAmount >= options.amount) {
      throw new Error(
        `An amount of ${options.amount} is too small to carry a ${config.feeBps} bps fee.`,
      );
    }
  }

  // Can an ARBITRARY customer pay this, in this coin? A card is quoted before
  // any customer is known, so that is the only question the issuer can ask -
  // and the registry answers it directly. Deriving an answer from the policy's
  // own filter words is not possible: read across both networks, neither the
  // ids nor the types are a namespace, and accounts whose sender policy reads
  // "reject-all" receive transfers every day.
  const recipientOpen = await canStrangerReceive(client, token, recipient);
  if (recipientOpen === null) {
    throw new Error(`Could not read the receive policy of ${recipient}.`);
  }
  if (!recipientOpen) {
    throw new Error(
      `${recipient} does not accept incoming transfers: its TIP-403 receive policy would block this payment.`,
    );
  }
  if (feeAddress !== undefined) {
    const treasuryOpen = await canStrangerReceive(client, token, feeAddress);
    if (treasuryOpen === null) {
      throw new Error(`Could not read the receive policy of the treasury ${feeAddress}.`);
    }
    if (!treasuryOpen) {
      throw new Error(
        `The treasury ${feeAddress} does not accept incoming transfers, so the fee leg would be blocked.`,
      );
    }
  }

  // Parsed by the same schema every customer will parse it with: an issuer must
  // never be able to emit a request its own reader refuses.
  const request = PaymentRequestV2Schema.parse({
    v: 2,
    chain: chain.caip2,
    asset: caip19ForAsset(chain.caip2, options.asset),
    recipient,
    amount: options.amount.toString(),
    ...(feeAddress === undefined
      ? {}
      : { fee_address: feeAddress, fee_amount: feeAmount.toString() }),
    memo: randomMemo(),
    // The CHAIN's clock, which is the one every deadline is judged on: the
    // verifier reads a block timestamp, never a wall clock. A provider whose
    // machine is behind chain time by more than the window would otherwise
    // issue requests born expired, and the first verify pass would answer
    // `none` before the customer could pay.
    created_at: options.nowSecs ?? finalized.timestamp,
    expiry_secs: expirySecs,
  });
  return { request, fromBlock: finalized.number };
}
