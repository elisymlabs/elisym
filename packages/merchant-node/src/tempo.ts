/**
 * Verifying Tempo payments for direct-mode orders: the merchant side of the
 * contract. A payment is bound to the order by its derived memo, pays terms the
 * store offered within the window before the leg's block time, lands at or
 * above the order's floor, and is claimed once by its settlement id.
 *
 * A reported hash is pre-read (one receipt) before any full verify, so a report
 * of someone else's hash costs one read; catch-up finds payments by memo per
 * (coin, payout address), never one scan per order.
 */
import { deriveOrderPaymentReference, parseCaip19 } from '@elisym/commerce';
import {
  type ChainConfig,
  type ParsedPaymentRequestV2,
  chainByCaip2,
  solanaConfigNetworkFor,
} from '@elisym/pay-core';
import {
  type Eip1193Client,
  type TempoTransferLog,
  composeTempoPaymentRequest,
  createJsonRpcClient,
  listTempoLogs,
  readBlockByNumber,
  readFinalizedBlock,
  readTempoReceiptLegs,
  verifyTempoPayment,
} from '@elisym/pay-core/evm';
import type { MerchantConfig } from './config';
import { CATCH_UP_SECS, MAX_RECHECKS_PER_SWEEP, ORDER_SCAN_MARGIN_SECS } from './constants';
import { knownTreasuries, paymentFloor } from './fee';
import {
  type LedgerState,
  type MerchantOrder,
  type WebhookOutbox,
  claimPayment,
  clearFeeUnresolved,
  openOrders,
  recordPayment,
} from './ledger';
import { TEMPO_HASH_RE } from './order-rules';
import { orderProductD } from './products';
import { type CatchUpResult, type PaymentCheck, contextNow, noteUnresolved } from './solana';
import { type OfferTerms, termsAt, termsSince, termsSinceAll } from './terms';

export interface TempoContext {
  client: Eip1193Client;
  chain: ChainConfig;
  /** The receipt medium of the chain: `tempo` or `tempo-moderato`. */
  medium: string;
  storePubkey: string;
  /** With a webhook configured: a payment verified here queues its `order.paid` webhook. */
  outbox?: WebhookOutbox;
  /** Block timestamps read so far (a restart costs a few binary-search reads). */
  samples?: Map<number, number>;
  /** Seconds: the moment the known treasuries are judged at. Default: the system clock. */
  now?: () => number;
}

/** How a reported Tempo hash came out, beyond Solana's verdicts. */
export type TempoCheck =
  | PaymentCheck
  /** Its receipt (or every term's verify) showed no leg for this order: set aside, not refused. */
  | { kind: 'no_leg' }
  /** A transfer to the payout that the recipient's policy blocked: noted for the owner. */
  | { kind: 'blocked' };

/**
 * The Tempo context of a config with a `tempo` block: its chain from the
 * registry, the operator's RPC or the chain's public one, and the medium.
 */
export function tempoContextFor(
  config: Pick<MerchantConfig, 'tempo'>,
  storePubkey: string,
): TempoContext | undefined {
  if (config.tempo === undefined) {
    return undefined;
  }
  const chain = chainByCaip2(config.tempo.network === 'mainnet' ? 'eip155:4217' : 'eip155:42431');
  const url = config.tempo.rpcUrl ?? chain?.rpcUrls[0];
  if (chain === undefined || url === undefined) {
    return undefined;
  }
  return {
    client: createJsonRpcClient(url),
    chain,
    medium: config.tempo.network === 'mainnet' ? 'tempo' : 'tempo-moderato',
    storePubkey,
  };
}

/** Block timestamps kept at most (the binary search's cache). */
const MAX_BLOCK_SAMPLES = 10_000;

/** The rumor may be dated up to 15 minutes ahead: the scan starts this far before it. */
const FLOOR_MARGIN_SECS = Math.max(ORDER_SCAN_MARGIN_SECS, 900);

export function tempoMemo(order: MerchantOrder, storePubkey: string): string {
  return deriveOrderPaymentReference({
    storePubkey,
    buyerPubkey: order.buyerPubkey,
    orderId: order.orderId,
  }).tempo;
}

export interface TempoTerms {
  terms: OfferTerms;
  token: string;
}

function tempoTerms(terms: readonly OfferTerms[], context: TempoContext): TempoTerms[] {
  return terms.flatMap((each) => {
    const caip19 = parseCaip19(each.caip19);
    const mint = caip19?.asset.mint;
    if (caip19?.chain.caip2 !== context.chain.caip2 || mint === undefined) {
      return [];
    }
    return [{ terms: each, token: mint.toLowerCase() }];
  });
}

/** The terms of the order's own product a payment for it may pay: the candidates a leg is verified against. */
export function orderTempoCandidates(
  state: LedgerState,
  order: MerchantOrder,
  context: TempoContext,
): TempoTerms[] {
  return tempoTerms(
    termsSince(state.terms, orderProductD(order), order.createdAt - ORDER_SCAN_MARGIN_SECS),
    context,
  );
}

async function blockTime(context: TempoContext, number: number): Promise<number | undefined> {
  const cached = context.samples?.get(number);
  if (cached !== undefined) {
    return cached;
  }
  const block = await readBlockByNumber(context.client, number);
  if (block === null) {
    return undefined;
  }
  const samples = (context.samples ??= new Map());
  // Bounded: a restart costs a few binary-search reads, never unbounded memory.
  if (samples.size >= MAX_BLOCK_SAMPLES) {
    samples.clear();
  }
  samples.set(number, block.timestamp);
  return block.timestamp;
}

/**
 * The newest finalized block at or before `time`, clamped to the catch-up
 * lookback: a binary search over block timestamps. `undefined` when the chain
 * could not be read.
 */
export async function blockAtTime(
  context: TempoContext,
  time: number,
): Promise<{ number: number; timestamp: number } | undefined> {
  const head = await readFinalizedBlock(context.client);
  if (head === null) {
    return undefined;
  }
  const target = Math.max(time, head.timestamp - CATCH_UP_SECS - FLOOR_MARGIN_SECS);
  if (head.timestamp <= target) {
    return head;
  }
  // Start from the closest samples already read around the target: a sweep's
  // searches for nearby times then cost a few reads, not a full search each.
  let low = 0;
  let high = head.number;
  let found = { number: 0, timestamp: 0 };
  for (const [number, at] of context.samples ?? []) {
    if (number > high || number < low) {
      continue;
    }
    if (at <= target && number >= low) {
      low = number;
      found = { number, timestamp: at };
    } else if (at > target && number <= high) {
      high = number;
    }
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const at = await blockTime(context, middle);
    if (at === undefined) {
      return undefined;
    }
    if (at <= target) {
      found = { number: middle, timestamp: at };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** The floor of an order's scan: the finalized block at its `created_at` less the margin. */
export function orderFloor(context: TempoContext, order: MerchantOrder) {
  return blockAtTime(context, order.createdAt - FLOOR_MARGIN_SECS);
}

type TermVerdict = 'paid' | 'ask' | 'unresolved' | 'refused' | 'no_leg' | 'claimed';

/** One term to verify a receipt against, with the fee leg its split carries (paid rule 2). */
interface TermPlan {
  candidate: TempoTerms;
  fee?: { treasury: string; amount: bigint };
}

/** The largest single leg of `token` to `to` among `legs`, or 0. */
function largestLeg(legs: readonly TempoTransferLog[], token: string, to: string): bigint {
  let largest = 0n;
  for (const leg of legs) {
    if (leg.token === token && leg.to === to && leg.amount > largest) {
      largest = leg.amount;
    }
  }
  return largest;
}

/**
 * Plan each term against one receipt's legs (with `P` the term's price, `B`
 * the LARGEST single leg to its payout, `FLOOR` the price less a fee at the
 * program's cap): `B >= P` is verified as before fees (rule 1); `FLOOR <= B <
 * P` with a known treasury other than the payout getting `P - B` in one leg of
 * the same receipt is verified as that split (rule 2), and without one is
 * unresolved (rule 3); a smaller leg is verified as before fees, which finds no
 * leg for it (rule 4). Only a term with a leg of at least the lowest floor is
 * named at all.
 */
function planTerms(
  candidates: readonly TempoTerms[],
  transfers: readonly TempoTransferLog[],
  treasuries: readonly string[],
): { plans: TermPlan[]; unresolved: boolean } {
  const lowestFloor = candidates.reduce<bigint | undefined>((lowest, candidate) => {
    const floor = paymentFloor(BigInt(candidate.terms.amount));
    return lowest === undefined || floor < lowest ? floor : lowest;
  }, undefined);
  const plans: TermPlan[] = [];
  let unresolved = false;
  for (const candidate of candidates) {
    const price = BigInt(candidate.terms.amount);
    const bound = largestLeg(transfers, candidate.token, candidate.terms.payout);
    if (bound === 0n || lowestFloor === undefined || bound < lowestFloor) {
      continue;
    }
    if (bound >= price || bound < paymentFloor(price)) {
      plans.push({ candidate });
      continue;
    }
    const fee = price - bound;
    // A treasury that is the payout would count the merchant's own leg twice.
    const treasury = treasuries.find(
      (each) =>
        each !== candidate.terms.payout && largestLeg(transfers, candidate.token, each) >= fee,
    );
    if (treasury === undefined) {
      unresolved = true;
    } else {
      plans.push({ candidate, fee: { treasury, amount: fee } });
    }
  }
  return { plans, unresolved };
}

/**
 * Verify `hash` for `order` against each planned term. Any PAID credits; else
 * any ASK (or UNRESOLVED, which is an ask) asks again (it wins over refusals,
 * as on Solana); else all R refuses; else (N, or a mix of R and N) there is no
 * leg. `satisfies` marks the terms a leg the caller already decoded could pay:
 * an N for one of those contradicts the caller's own read and counts as ASK.
 * A split is credited only with both legs in this very transaction: one paid
 * across transactions is unresolved.
 */
async function verifyTerms(
  state: LedgerState,
  order: MerchantOrder,
  hash: string,
  context: TempoContext,
  plans: readonly TermPlan[],
  floor: { number: number; timestamp: number },
  satisfies: (terms: TempoTerms) => boolean,
): Promise<TermVerdict> {
  const memo = tempoMemo(order, context.storePubkey);
  const verdicts: TermVerdict[] = [];
  for (const { candidate, fee } of plans) {
    const caip19 = parseCaip19(candidate.terms.caip19);
    if (caip19 === undefined) {
      continue;
    }
    const price = BigInt(candidate.terms.amount);
    let request: ParsedPaymentRequestV2;
    try {
      request = composeTempoPaymentRequest({
        chain: context.chain,
        asset: caip19.asset,
        recipient: candidate.terms.payout,
        amount: price,
        feeAmount: fee?.amount ?? 0n,
        treasury: fee?.treasury ?? candidate.terms.payout,
        memo,
        createdAt: floor.timestamp,
      });
    } catch {
      continue;
    }
    const result = await verifyTempoPayment(context.client, request, {
      txSignature: hash,
      fromBlock: floor.number,
      pollBudgetMs: 0,
    });
    if (result.outcome === 'verified') {
      const leg: TempoTransferLog = result.providerLeg;
      if (
        fee !== undefined &&
        (leg.transactionHash !== hash || result.feeLeg?.transactionHash !== hash)
      ) {
        verdicts.push('unresolved');
        continue;
      }
      const at = await blockTime(context, leg.blockNumber);
      if (at === undefined) {
        verdicts.push('ask');
        continue;
      }
      // The block-time guard: only the order's own product, at exactly these terms.
      const offered = termsAt(state.terms, orderProductD(order), at).some(
        (standing) =>
          standing.caip19 === candidate.terms.caip19 &&
          standing.payout === candidate.terms.payout &&
          standing.amount === candidate.terms.amount,
      );
      if (leg.blockNumber < floor.number || !offered) {
        verdicts.push('refused');
        continue;
      }
      if (!claimPayment(state, result.settlementId, order.key)) {
        return 'claimed';
      }
      recordPayment(
        order,
        {
          signature: leg.transactionHash,
          // A split records the price (the merchant's leg and the fee); any
          // treasury excess above the fee is not the merchant's.
          amount: (fee === undefined ? leg.amount : price).toString(),
          fee: (fee?.amount ?? 0n).toString(),
          blockTime: at,
          caip19: candidate.terms.caip19,
          medium: context.medium,
        },
        context.outbox,
      );
      return 'paid';
    }
    if (
      result.outcome === 'refused' &&
      (result.code === 'fee_leg_missing' || result.code === 'fee_leg_blocked')
    ) {
      verdicts.push('unresolved');
      continue;
    }
    if (
      result.outcome === 'refused' &&
      (result.code === 'reverted' || result.code === 'no_provider_leg')
    ) {
      verdicts.push(satisfies(candidate) ? 'ask' : 'no_leg');
      continue;
    }
    verdicts.push('ask');
  }
  if (verdicts.includes('unresolved')) {
    return 'unresolved';
  }
  if (verdicts.includes('ask')) {
    return 'ask';
  }
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'refused')) {
    return 'refused';
  }
  return 'no_leg';
}

function asCheck(verdict: TermVerdict, order: MerchantOrder): TempoCheck {
  switch (verdict) {
    case 'paid':
      return { kind: 'paid', order };
    case 'claimed':
      return { kind: 'refused', reason: 'claimed_by_another_order' };
    case 'refused':
      return { kind: 'refused', reason: 'not_a_payment_for_this_order' };
    case 'no_leg':
      return { kind: 'no_leg' };
    case 'unresolved':
      return { kind: 'ask_again', feeUnresolved: true };
    case 'ask':
      return { kind: 'ask_again' };
  }
  return { kind: 'ask_again' };
}

/**
 * Check one hash for `order`. The receipt is read first (trusted as a verify
 * by hash trusts one), with every leg of the order's memo to a payout or a
 * known elisym treasury: no receipt asks again, a trusted receipt with no leg
 * for this order sets the hash aside (`no_leg`), a guard log of at least the
 * floor to a payout with no transfer notes `blocked`. Only a hash with a leg is
 * verified in full, by the paid rule of `planTerms`.
 *
 * `scanned`: the leg a memo scan found under this hash (catch-up). A receipt
 * that does not show it (the same coin and payout, at least its amount)
 * contradicts the scan and asks again; one that shows it with no leg this
 * order's terms can use is `no_leg`. No blocked note is taken from a scanned hash.
 */
export async function checkTempoPayment(
  state: LedgerState,
  order: MerchantOrder,
  hash: string,
  context: TempoContext,
  scanned?: TempoTransferLog,
): Promise<TempoCheck> {
  if (order.paid !== undefined) {
    return order.paid.signature === hash
      ? { kind: 'paid', order }
      : { kind: 'refused', reason: 'order_already_paid' };
  }
  const candidates = orderTempoCandidates(state, order, context);
  if (candidates.length === 0) {
    return scanned === undefined
      ? { kind: 'refused', reason: 'not_a_payment_for_this_order' }
      : { kind: 'no_leg' };
  }
  const treasuries = knownTreasuries(
    state,
    solanaConfigNetworkFor(context.chain.caip2),
    'evm',
    contextNow(context),
  );
  const pre = await readTempoReceiptLegs(context.client, hash, {
    chain: context.chain,
    tokens: [
      ...new Set([
        ...candidates.map((candidate) => candidate.token),
        ...(scanned === undefined ? [] : [scanned.token]),
      ]),
    ],
    recipients: [
      ...new Set([
        ...candidates.map((candidate) => candidate.terms.payout),
        ...treasuries,
        ...(scanned === undefined ? [] : [scanned.to]),
      ]),
    ],
    memo: tempoMemo(order, context.storePubkey),
    // Every leg: the paid rule needs the largest to the payout and to each treasury.
    minAmount: 1n,
  });
  if (pre.kind === 'unreadable' || pre.kind === 'absent') {
    return { kind: 'ask_again' };
  }
  if (pre.kind === 'none') {
    return scanned === undefined ? { kind: 'no_leg' } : { kind: 'ask_again' };
  }
  const { plans, unresolved } = planTerms(candidates, pre.transfers, treasuries);
  if (plans.length === 0) {
    if (unresolved) {
      return { kind: 'ask_again', feeUnresolved: true };
    }
    // A scanned leg the receipt shows but no term of this order can use (below
    // its own floor: the scan reads down to the lowest floor of every product)
    // has no leg for this order; one the receipt does not show asks again.
    if (scanned !== undefined) {
      return receiptShows(pre.transfers, scanned) ? { kind: 'no_leg' } : { kind: 'ask_again' };
    }
    // Transfer legs first: only a receipt with none of them is a blocked note,
    // and only from a guard log of at least the floor to a payout (never a
    // treasury's or dust).
    const blocked = pre.blocked.some((guard) =>
      candidates.some(
        (candidate) =>
          guard.token === candidate.token &&
          guard.receiver === candidate.terms.payout &&
          guard.amount >= paymentFloor(BigInt(candidate.terms.amount)),
      ),
    );
    if (blocked) {
      order.blockedTx = hash;
      return { kind: 'blocked' };
    }
    return { kind: 'no_leg' };
  }
  const floor = await orderFloor(context, order);
  if (floor === undefined) {
    return { kind: 'ask_again' };
  }
  const satisfies = (candidate: TempoTerms) =>
    scanned !== undefined &&
    candidate.token === scanned.token &&
    candidate.terms.payout === scanned.to &&
    scanned.amount >= paymentFloor(BigInt(candidate.terms.amount));
  const verdict = await verifyTerms(state, order, hash, context, plans, floor, satisfies);
  return asCheck(verdict === 'paid' || !unresolved ? verdict : 'unresolved', order);
}

/** Whether a receipt's `transfers` carry `scanned`: the same coin and payout, at least its amount. */
function receiptShows(transfers: readonly TempoTransferLog[], scanned: TempoTransferLog): boolean {
  return transfers.some(
    (leg) => leg.token === scanned.token && leg.to === scanned.to && leg.amount >= scanned.amount,
  );
}

/** Keep what a reported hash came out as: refused and set-aside hashes are not rechecked. */
export function recordTempoCheck(order: MerchantOrder, hash: string, check: TempoCheck): void {
  if (check.kind === 'refused') {
    order.refusedTxs = [...(order.refusedTxs ?? []), hash];
    clearFeeUnresolved(order, hash);
  } else if (check.kind === 'no_leg') {
    if (order.noLegTxs?.includes(hash) !== true) {
      order.noLegTxs = [...(order.noLegTxs ?? []), hash];
    }
    clearFeeUnresolved(order, hash);
  }
}

/**
 * Catch up on every open order at once. Reported hashes still to judge are
 * checked first (`checkTempoPayment`), oldest check first, within the sweep's
 * budget. Then one memo scan per (coin, payout address), from the oldest open
 * order's floor and down to the lowest payment floor of its terms, matched
 * locally against the open orders' derived memos. A match is judged by its
 * receipt with the scanned leg (`checkTempoPayment` with `scanned`), also when
 * its hash sits in `noLegTxs` (the match lifts it); a hash already refused or
 * found with no leg for the order (`tempoNoLeg`) is not judged again; an ask is
 * judged again, oldest check first, within the sweep's budget.
 */
export async function catchUpTempo(
  state: LedgerState,
  context: TempoContext,
  now: number,
): Promise<CatchUpResult> {
  const result: CatchUpResult = { paid: [], incomplete: [] };
  const open = openOrders(state, now, CATCH_UP_SECS);
  if (open.length === 0) {
    return result;
  }
  const checkContext: TempoContext = { ...context, now: () => now };
  // Reported hashes still to judge (asked again), first in first out, within the budget.
  const reported: { order: MerchantOrder; hash: string; checkedAt: number }[] = [];
  for (const order of open) {
    for (const hash of order.reportedTxs) {
      if (
        TEMPO_HASH_RE.test(hash) &&
        order.refusedTxs?.includes(hash) !== true &&
        order.noLegTxs?.includes(hash) !== true &&
        order.blockedTx !== hash
      ) {
        reported.push({ order, hash, checkedAt: order.recheckedAt?.[hash] ?? 0 });
      }
    }
  }
  reported.sort((left, right) => left.checkedAt - right.checkedAt);
  for (const { order, hash } of reported.slice(0, MAX_RECHECKS_PER_SWEEP)) {
    if (order.paid !== undefined) {
      continue;
    }
    order.recheckedAt = { ...order.recheckedAt, [hash]: now };
    const check = await checkTempoPayment(state, order, hash, checkContext);
    recordTempoCheck(order, hash, check);
    noteUnresolved(order, hash, check, now, result);
    if (check.kind === 'paid') {
      result.paid.push(order);
    }
  }
  const oldest = Math.min(...open.map((order) => order.createdAt));
  // Every product's terms: the scan only finds legs, each judged for its order's product.
  const candidates = tempoTerms(
    termsSinceAll(state.terms, oldest - ORDER_SCAN_MARGIN_SECS),
    context,
  );
  if (candidates.length === 0) {
    return result;
  }
  const floor = await blockAtTime(context, oldest - FLOOR_MARGIN_SECS);
  if (floor === undefined) {
    return result;
  }
  const byMemo = new Map(open.map((order) => [tempoMemo(order, context.storePubkey), order]));
  const matches: { order: MerchantOrder; leg: TempoTransferLog; checkedAt: number }[] = [];
  const pairs = new Map<string, TempoTerms[]>();
  for (const candidate of candidates) {
    const key = `${candidate.token}:${candidate.terms.payout}`;
    pairs.set(key, [...(pairs.get(key) ?? []), candidate]);
  }
  for (const [key, terms] of pairs) {
    const [token, payout] = key.split(':') as [string, string];
    // Down to the lowest floor: a split leaves the merchant less than the price.
    const floors = terms.map((each) => paymentFloor(BigInt(each.terms.amount)));
    const lowestFloor = floors.reduce(
      (lowest, floor) => (floor < lowest ? floor : lowest),
      floors[0] ?? 1n,
    );
    const minAmount = lowestFloor > 0n ? lowestFloor : 1n;
    const scan = await listTempoLogs(context.client, {
      token,
      event: 'TransferWithMemo',
      to: payout,
      fromBlock: floor.number,
      minAmount,
    });
    if (!scan.complete) {
      result.incomplete.push(`${context.chain.caip2} ${token} ${payout}`);
    }
    for (const leg of scan.candidates) {
      const order = leg.memo === undefined ? undefined : byMemo.get(leg.memo);
      if (
        order === undefined ||
        order.paid !== undefined ||
        order.refusedTxs?.includes(leg.transactionHash) === true ||
        order.tempoNoLeg?.includes(leg.transactionHash) === true
      ) {
        continue;
      }
      matches.push({ order, leg, checkedAt: order.recheckedAt?.[leg.transactionHash] ?? 0 });
    }
  }
  matches.sort((left, right) => left.checkedAt - right.checkedAt);
  for (const { order, leg } of matches.slice(0, MAX_RECHECKS_PER_SWEEP)) {
    if (order.paid !== undefined) {
      continue;
    }
    const hash = leg.transactionHash;
    order.recheckedAt = { ...order.recheckedAt, [hash]: now };
    // Judged by its receipt, by the same paid rule as a reported hash.
    const check = await checkTempoPayment(state, order, hash, checkContext, leg);
    // A match lifts a hash the pre-read set aside.
    if (order.noLegTxs?.includes(hash) === true) {
      order.noLegTxs = order.noLegTxs.filter((each) => each !== hash);
    }
    noteUnresolved(order, hash, check, now, result);
    if (check.kind === 'paid') {
      result.paid.push(order);
    } else if (check.kind === 'refused') {
      order.refusedTxs = [...(order.refusedTxs ?? []), hash];
      clearFeeUnresolved(order, hash);
    } else if (check.kind === 'no_leg') {
      order.tempoNoLeg = [...(order.tempoNoLeg ?? []), hash];
      clearFeeUnresolved(order, hash);
    }
  }
  return result;
}
