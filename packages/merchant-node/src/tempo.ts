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
import { type ChainConfig, type ParsedPaymentRequestV2, chainByCaip2 } from '@elisym/pay-core';
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
import {
  type LedgerState,
  type MerchantOrder,
  claimPayment,
  markTempo,
  openOrders,
} from './ledger';
import { TEMPO_HASH_RE } from './order-rules';
import type { CatchUpResult, PaymentCheck } from './solana';
import { type OfferTerms, termsAt, termsSince } from './terms';

export interface TempoContext {
  client: Eip1193Client;
  chain: ChainConfig;
  /** The receipt medium of the chain: `tempo` or `tempo-moderato`. */
  medium: string;
  storePubkey: string;
  /** Block timestamps read so far (a restart costs a few binary-search reads). */
  samples?: Map<number, number>;
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

interface TempoTerms {
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

type TermVerdict = 'paid' | 'ask' | 'refused' | 'no_leg' | 'claimed';

/**
 * Verify `hash` for `order` against each candidate term. Any PAID credits;
 * else any ASK asks again (it wins over refusals, as on Solana); else all R
 * refuses; else (N, or a mix of R and N) there is no leg. `satisfies` marks the
 * terms a leg the caller already decoded could pay: an N for one of those
 * contradicts the caller's own read and counts as ASK.
 */
async function verifyTerms(
  state: LedgerState,
  order: MerchantOrder,
  hash: string,
  context: TempoContext,
  candidates: readonly TempoTerms[],
  floor: { number: number; timestamp: number },
  satisfies: (terms: TempoTerms) => boolean,
): Promise<TermVerdict> {
  const memo = tempoMemo(order, context.storePubkey);
  const verdicts: TermVerdict[] = [];
  for (const candidate of candidates) {
    const caip19 = parseCaip19(candidate.terms.caip19);
    if (caip19 === undefined) {
      continue;
    }
    let request: ParsedPaymentRequestV2;
    try {
      request = composeTempoPaymentRequest({
        chain: context.chain,
        asset: caip19.asset,
        recipient: candidate.terms.payout,
        amount: BigInt(candidate.terms.amount),
        feeBps: 0,
        treasury: candidate.terms.payout,
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
      const at = await blockTime(context, leg.blockNumber);
      if (at === undefined) {
        verdicts.push('ask');
        continue;
      }
      const offered = termsAt(state.terms, at).some(
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
      markTempo(state);
      order.paid = {
        signature: leg.transactionHash,
        amount: leg.amount.toString(),
        blockTime: at,
        caip19: candidate.terms.caip19,
        medium: context.medium,
      };
      return 'paid';
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
    case 'ask':
      return { kind: 'ask_again' };
  }
  return { kind: 'ask_again' };
}

/**
 * Check one hash a buyer reported for `order`. The receipt is read first
 * (trusted as a verify by hash trusts one): no receipt asks again, a trusted
 * receipt with no leg for this order sets the hash aside (`no_leg`), a guard log
 * with no transfer notes `blocked`. Only a hash with a leg is verified in full.
 */
export async function checkTempoPayment(
  state: LedgerState,
  order: MerchantOrder,
  hash: string,
  context: TempoContext,
): Promise<TempoCheck> {
  if (order.paid !== undefined) {
    return order.paid.signature === hash
      ? { kind: 'paid', order }
      : { kind: 'refused', reason: 'order_already_paid' };
  }
  const candidates = tempoTerms(
    termsSince(state.terms, order.createdAt - ORDER_SCAN_MARGIN_SECS),
    context,
  );
  if (candidates.length === 0) {
    return { kind: 'refused', reason: 'not_a_payment_for_this_order' };
  }
  const minAmount = candidates.reduce(
    (lowest, candidate) =>
      BigInt(candidate.terms.amount) < lowest ? BigInt(candidate.terms.amount) : lowest,
    BigInt(candidates[0]?.terms.amount ?? '0'),
  );
  const pre = await readTempoReceiptLegs(context.client, hash, {
    chain: context.chain,
    tokens: [...new Set(candidates.map((candidate) => candidate.token))],
    recipients: [...new Set(candidates.map((candidate) => candidate.terms.payout))],
    memo: tempoMemo(order, context.storePubkey),
    minAmount,
  });
  if (pre.kind === 'unreadable' || pre.kind === 'absent') {
    return { kind: 'ask_again' };
  }
  if (pre.kind === 'none') {
    return { kind: 'no_leg' };
  }
  // Transfer legs first: only a receipt with none of them is a blocked note.
  const named = candidates.filter((candidate) =>
    pre.transfers.some((leg) => leg.token === candidate.token && leg.to === candidate.terms.payout),
  );
  if (named.length === 0) {
    if (pre.blocked.length > 0) {
      order.blockedTx = hash;
      markTempo(state);
      return { kind: 'blocked' };
    }
    return { kind: 'no_leg' };
  }
  const floor = await orderFloor(context, order);
  if (floor === undefined) {
    return { kind: 'ask_again' };
  }
  return asCheck(await verifyTerms(state, order, hash, context, named, floor, () => false), order);
}

/** Keep what a reported hash came out as: refused and set-aside hashes are not rechecked. */
export function recordTempoCheck(
  state: LedgerState,
  order: MerchantOrder,
  hash: string,
  check: TempoCheck,
): void {
  if (check.kind === 'refused') {
    order.refusedTxs = [...(order.refusedTxs ?? []), hash];
  } else if (check.kind === 'no_leg' && order.noLegTxs?.includes(hash) !== true) {
    order.noLegTxs = [...(order.noLegTxs ?? []), hash];
  }
  markTempo(state);
}

/**
 * Catch up on every open order at once, per (coin, payout address): one memo
 * scan from the oldest open order's floor, matched locally against the open
 * orders' derived memos. A match goes straight to verify (no pre-read), also
 * when its hash sits in `noLegTxs`; an order's cached N for that hash is not
 * verified again; an ASK is verified again, oldest check first, within the
 * sweep's budget.
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
    const check = await checkTempoPayment(state, order, hash, context);
    recordTempoCheck(state, order, hash, check);
    if (check.kind === 'paid') {
      result.paid.push(order);
    }
  }
  const oldest = Math.min(...open.map((order) => order.createdAt));
  const candidates = tempoTerms(termsSince(state.terms, oldest - ORDER_SCAN_MARGIN_SECS), context);
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
    const minAmount = terms.reduce(
      (lowest, each) => (BigInt(each.terms.amount) < lowest ? BigInt(each.terms.amount) : lowest),
      BigInt(terms[0]?.terms.amount ?? '0'),
    );
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
    const orderFloorBlock = await orderFloor(context, order);
    if (orderFloorBlock === undefined) {
      continue;
    }
    const orderTerms = tempoTerms(
      termsSince(state.terms, order.createdAt - ORDER_SCAN_MARGIN_SECS),
      context,
    );
    const verdict = await verifyTerms(
      state,
      order,
      hash,
      context,
      orderTerms,
      orderFloorBlock,
      (candidate) =>
        candidate.token === leg.token &&
        candidate.terms.payout === leg.to &&
        leg.amount >= BigInt(candidate.terms.amount),
    );
    markTempo(state);
    // A match lifts a hash the pre-read set aside.
    if (order.noLegTxs?.includes(hash) === true) {
      order.noLegTxs = order.noLegTxs.filter((each) => each !== hash);
    }
    if (verdict === 'paid') {
      result.paid.push(order);
    } else if (verdict === 'refused') {
      order.refusedTxs = [...(order.refusedTxs ?? []), hash];
    } else if (verdict === 'no_leg') {
      order.tempoNoLeg = [...(order.tempoNoLeg ?? []), hash];
    }
  }
  return result;
}
