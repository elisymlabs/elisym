import { parseCaip19 } from '@elisym/commerce';
import {
  type Asset,
  type DirectInstruction,
  type Network,
  ELISYM_PROTOCOL_TAG,
  boundTransferAmount,
  composeSolanaPaymentRequest,
  directInstructionsFromRpcTransaction,
  listReferenceSignatures,
  verifyDirectSolanaPayment,
} from '@elisym/pay-core';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { type Rpc, type Signature, type SolanaRpcApi, address } from '@solana/kit';
import {
  CATCH_UP_SECS,
  MAX_RECHECKS_PER_SWEEP,
  ORDER_SCAN_MARGIN_SECS,
  SOLANA_MEDIUMS,
  TERMS_WINDOW_SECS,
} from './constants';
import {
  type LedgerState,
  type MerchantOrder,
  type ScannedTransaction,
  claimPayment,
  openOrders,
} from './ledger';
import { isSolanaSignature } from './signature';
import { type OfferTerms, termsAt, termsSince } from './terms';

export interface SolanaContext {
  rpc: Rpc<SolanaRpcApi>;
  network: Network;
}

export type PaymentCheck =
  | { kind: 'paid'; order: MerchantOrder }
  /** Nothing final was learned (a node error, a page not readable, not landed yet). */
  | { kind: 'ask_again' }
  | {
      kind: 'refused';
      reason: 'claimed_by_another_order' | 'not_a_payment_for_this_order' | 'order_already_paid';
    };

/** The Solana coin of `terms` on this network, or `undefined` for another chain or network. */
function solanaAsset(terms: OfferTerms, network: Network): Asset | undefined {
  const caip19 = parseCaip19(terms.caip19);
  if (
    caip19 === undefined ||
    caip19.chain.family !== 'solana' ||
    caip19.chain.network !== network
  ) {
    return undefined;
  }
  return caip19.asset;
}

const ASK_AGAIN_REASONS: readonly string[] = ['rpc_error', 'unreadable', 'not_found'];

/**
 * Check one transaction against one order, per the direct-mode contract: the
 * payment is bound to the order's derived reference at the instruction level,
 * pays terms the store offered within the window before the payment's block
 * time, and is claimed once. On `paid` the ledger holds the claim and the
 * payment; the caller saves it before delivering.
 */
export async function checkPayment(
  state: LedgerState,
  order: MerchantOrder,
  signature: string,
  context: SolanaContext,
): Promise<PaymentCheck> {
  const holder = state.claims[signature];
  if (holder !== undefined && holder !== order.key) {
    return { kind: 'refused', reason: 'claimed_by_another_order' };
  }
  // An order is paid once: a second payment is kept for a refund by hand, never credited.
  if (order.paid !== undefined) {
    return order.paid.signature === signature
      ? { kind: 'paid', order }
      : { kind: 'refused', reason: 'order_already_paid' };
  }
  const candidates = termsSince(state.terms, order.createdAt - ORDER_SCAN_MARGIN_SECS);
  let askAgain = false;
  for (const terms of candidates) {
    const asset = solanaAsset(terms, context.network);
    if (asset === undefined) {
      continue;
    }
    const request = composeSolanaPaymentRequest({
      recipient: terms.payout,
      amount: BigInt(terms.amount),
      asset,
      network: context.network,
      reference: order.reference,
      createdAt: order.createdAt,
    });
    const verdict = await verifyDirectSolanaPayment(context.rpc, request, signature);
    if (!verdict.verified) {
      askAgain ||= ASK_AGAIN_REASONS.includes(verdict.reason);
      continue;
    }
    // A null block time is judged again later, never guessed.
    if (verdict.blockTime === null) {
      askAgain = true;
      continue;
    }
    const offered = termsAt(state.terms, verdict.blockTime).some(
      (standing) =>
        standing.caip19 === terms.caip19 &&
        standing.payout === terms.payout &&
        standing.amount === terms.amount,
    );
    if (!offered) {
      continue;
    }
    if (!claimPayment(state, signature, order.key)) {
      return { kind: 'refused', reason: 'claimed_by_another_order' };
    }
    order.paid = {
      signature,
      amount: verdict.amount.toString(),
      blockTime: verdict.blockTime,
      caip19: terms.caip19,
      medium: SOLANA_MEDIUMS[context.network],
    };
    return { kind: 'paid', order };
  }
  return askAgain
    ? { kind: 'ask_again' }
    : { kind: 'refused', reason: 'not_a_payment_for_this_order' };
}

/** The account a payout's payments land in: the wallet for SOL, its associated token account otherwise. */
export async function receivingAccount(terms: OfferTerms, asset: Asset): Promise<string> {
  if (asset.mint === undefined) {
    return terms.payout;
  }
  const [account] = await findAssociatedTokenPda({
    owner: address(terms.payout),
    mint: address(asset.mint),
    tokenProgram:
      asset.tokenProgram === undefined ? TOKEN_PROGRAM_ADDRESS : address(asset.tokenProgram),
  });
  return account;
}

/**
 * The references a transaction binds a transfer to, into `terms.payout`: every
 * account placed just before the protocol tag is a candidate, and pay-core's
 * binding decides. Read without knowing any order, so one read serves them all.
 */
async function boundReferences(
  instructions: readonly DirectInstruction[],
  terms: OfferTerms,
  asset: Asset,
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const instruction of instructions) {
    const { accounts } = instruction;
    const tag = accounts[accounts.length - 1];
    const reference = accounts[accounts.length - 2];
    if (tag?.address === ELISYM_PROTOCOL_TAG && reference !== undefined) {
      candidates.add(reference.address);
    }
  }
  const bound: string[] = [];
  for (const reference of candidates) {
    const amount = await boundTransferAmount(instructions, {
      reference,
      recipient: terms.payout,
      asset,
    });
    if (amount > 0n) {
      bound.push(reference);
    }
  }
  return bound;
}

/** Read one landed transaction of a payout account, or `undefined` when it cannot be judged yet. */
async function scanTransaction(
  signature: Signature,
  terms: OfferTerms,
  asset: Asset,
  context: SolanaContext,
): Promise<ScannedTransaction | undefined> {
  let transaction: unknown;
  try {
    transaction = await context.rpc
      .getTransaction(signature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
  } catch {
    return undefined;
  }
  if (transaction === null || typeof transaction !== 'object') {
    return undefined;
  }
  const blockTime: unknown = Reflect.get(transaction, 'blockTime');
  // A null block time is judged again later: never cached, never guessed.
  if (typeof blockTime !== 'number' && typeof blockTime !== 'bigint') {
    return undefined;
  }
  let instructions: DirectInstruction[];
  try {
    instructions = directInstructionsFromRpcTransaction(transaction);
  } catch {
    return undefined;
  }
  return {
    blockTime: Number(blockTime),
    references: await boundReferences(instructions, terms, asset),
  };
}

export interface CatchUpResult {
  paid: MerchantOrder[];
  /** Receiving accounts whose history was cut short by the page cap: older payments may be missed. */
  incomplete: string[];
}

/**
 * Catch up on every open order at once, per payout ADDRESS (anyone can post
 * orders for free, so never one scan per order): list the payout's receiving
 * account back to the oldest open order, read each landed transaction ONCE
 * (the ledger keeps what it binds), and match its references to the open
 * orders locally. Transactions the buyers reported are checked again too.
 */
export async function catchUp(
  state: LedgerState,
  context: SolanaContext,
  now: number,
): Promise<CatchUpResult> {
  const result: CatchUpResult = { paid: [], incomplete: [] };
  const open = openOrders(state, now, CATCH_UP_SECS);
  forgetOldScans(state, now);
  if (open.length === 0) {
    return result;
  }
  const byReference = new Map(open.map((order) => [order.reference, order]));
  // A transaction finally refused for an order is remembered and never checked
  // for it again, whether it came from a receipt or from the account scan.
  const credit = async (order: MerchantOrder, signature: string) => {
    if (
      order.paid !== undefined ||
      order.refusedTxs?.includes(signature) === true ||
      state.claims[signature] !== undefined
    ) {
      return;
    }
    const check = await checkPayment(state, order, signature, context);
    if (check.kind === 'paid') {
      result.paid.push(order);
    } else if (check.kind === 'refused') {
      order.refusedTxs = [...(order.refusedTxs ?? []), signature];
    }
  };
  // Reported transactions not yet judged, first in first out (queue position:
  // arrival, then last check), under one budget for the whole sweep: every one
  // is reached within a few sweeps, and fresh reports cannot jump ahead of it.
  const pending: { order: MerchantOrder; signature: string; checkedAt: number }[] = [];
  for (const order of open) {
    for (const signature of order.reportedTxs) {
      if (
        order.paid === undefined &&
        order.refusedTxs?.includes(signature) !== true &&
        state.claims[signature] === undefined
      ) {
        // Its place in the queue: when it arrived, then when it was last checked.
        pending.push({ order, signature, checkedAt: order.recheckedAt?.[signature] ?? 0 });
      }
    }
  }
  pending.sort((left, right) => left.checkedAt - right.checkedAt);
  for (const { order, signature } of pending.slice(0, MAX_RECHECKS_PER_SWEEP)) {
    order.recheckedAt = { ...order.recheckedAt, [signature]: now };
    await credit(order, signature);
  }
  let oldest = Number.POSITIVE_INFINITY;
  for (const order of open) {
    oldest = Math.min(oldest, order.createdAt);
  }
  oldest -= ORDER_SCAN_MARGIN_SECS;
  const scannedAccounts = new Set<string>();
  for (const terms of termsSince(state.terms, oldest)) {
    const asset = solanaAsset(terms, context.network);
    if (asset === undefined) {
      continue;
    }
    const account = await receivingAccount(terms, asset);
    if (scannedAccounts.has(account)) {
      continue;
    }
    scannedAccounts.add(account);
    const listing = await listReferenceSignatures(context.rpc, account, {
      notBefore: oldest,
      commitment: 'confirmed',
    });
    if (!listing.complete) {
      result.incomplete.push(account);
    }
    for (const entry of listing.signatures) {
      // A listing page may reach below the floor; no open order needs those rows,
      // and reading them would repeat every sweep (they fall out of the memo).
      if (
        entry.failed ||
        !isSolanaSignature(entry.signature) ||
        (entry.blockTime !== null && entry.blockTime < oldest)
      ) {
        continue;
      }
      const memo = `${account}:${entry.signature}`;
      let scan: ScannedTransaction | undefined = state.scans[memo];
      if (scan === undefined) {
        scan = await scanTransaction(entry.signature, terms, asset, context);
        if (scan === undefined) {
          continue;
        }
        state.scans[memo] = scan;
      }
      for (const reference of scan.references) {
        const order = byReference.get(reference);
        if (order !== undefined) {
          await credit(order, entry.signature);
        }
      }
    }
  }
  return result;
}

/** Drop what the ledger remembers of transactions no open order can reach any more. */
function forgetOldScans(state: LedgerState, now: number): void {
  const horizon = now - CATCH_UP_SECS - ORDER_SCAN_MARGIN_SECS - TERMS_WINDOW_SECS;
  for (const [memo, scan] of Object.entries(state.scans)) {
    if (scan.blockTime < horizon) {
      delete state.scans[memo];
    }
  }
}
