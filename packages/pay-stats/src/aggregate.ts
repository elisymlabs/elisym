/**
 * From marked transfers to the rows the tool prints. Pure: no chain, no clock.
 *
 * A purchase is a distinct order REFERENCE (the Solana reference account, the
 * Tempo memo), never a transfer. Every candidate of the run - both rails, every
 * coin, every hour, from the marker launch on - is sorted by chain position
 * first, so the first transfer of a reference is well defined: it is the
 * purchase, counted on its own day with the gross of that transfer (provider
 * leg plus fee legs). A later transfer under a reference already seen is a
 * duplicate: counted and summed apart, never added to the volume (a second
 * payment the node refuses as `order_already_paid` is refunded by hand).
 * Refunds are not netted, and a transfer the node refused (stale terms, below
 * the floor) cannot be told apart from public data: it is counted.
 *
 * The output window (`since` / `until`) filters the ROWS only. A reference
 * first paid before `since` stays seen, so a duplicate of it inside the window
 * is a duplicate, never a purchase.
 */
import Decimal from 'decimal.js-light';
import { usdDecimalsOf } from './usd';

export type Rail = 'solana' | 'tempo';
export type StatsNetwork = 'mainnet' | 'devnet';

/** One marked payment: the legs of one transaction under one reference. */
export interface Candidate {
  rail: Rail;
  network: StatsNetwork;
  /** The order reference: the dedup key, across coins, days and rails. */
  reference: string;
  /** UTC day of the transfer, `YYYY-MM-DD`. */
  day: string;
  /**
   * Chain position: Solana slot then signature (a deterministic tie-break -
   * `getTransaction` gives no position inside a slot), Tempo block then log
   * index of the provider leg.
   */
  position: { primary: number; secondary: string | number };
  /** The coin: its registry symbol, or the raw mint / token (see `coinOf`). */
  coin: string;
  /** Who the provider leg paid (the payout owner). */
  payout: string;
  provider: bigint;
  fees: readonly { treasury: string; amount: bigint }[];
}

/** A count that is not a purchase: shown so the purchase rows can be read in context. */
export interface ContextCount {
  day: string;
  rail: Rail;
  bucket: string;
  count: number;
}

export interface PurchaseRow {
  day: string;
  rail: Rail;
  network: StatsNetwork;
  coin: string;
  payout: string;
  count: number;
  gross_subunits: string;
  gross_usd: string;
  provider_subunits: string;
  fee_subunits: string;
  duplicate_transfers: number;
  duplicate_subunits: string;
}

export interface FeeRow {
  day: string;
  rail: Rail;
  network: StatsNetwork;
  coin: string;
  treasury: string;
  fee_count: number;
  fee_subunits: string;
  fee_usd: string;
}

export interface ContextRow {
  day: string;
  rail: Rail;
  bucket: string;
  count: number;
}

export interface StatsReport {
  purchases: PurchaseRow[];
  fees: FeeRow[];
  context: ContextRow[];
}

export interface Window {
  since?: string;
  until?: string;
}

interface PurchaseTotals {
  day: string;
  rail: Rail;
  network: StatsNetwork;
  coin: string;
  payout: string;
  count: number;
  provider: bigint;
  fee: bigint;
  duplicates: number;
  duplicateGross: bigint;
}

interface FeeTotals {
  day: string;
  rail: Rail;
  network: StatsNetwork;
  coin: string;
  treasury: string;
  count: number;
  amount: bigint;
}

function inWindow(day: string, window: Window): boolean {
  return (
    (window.since === undefined || day >= window.since) &&
    (window.until === undefined || day <= window.until)
  );
}

function compareSecondary(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) {
    return 0;
  }
  return leftText < rightText ? -1 : 1;
}

/** Chain order: rail, then position. References never cross rails, so rails sort apart. */
export function byChainPosition(left: Candidate, right: Candidate): number {
  if (left.rail !== right.rail) {
    return left.rail < right.rail ? -1 : 1;
  }
  if (left.position.primary !== right.position.primary) {
    return left.position.primary - right.position.primary;
  }
  return compareSecondary(left.position.secondary, right.position.secondary);
}

function feeTotal(candidate: Candidate): bigint {
  return candidate.fees.reduce((sum, fee) => sum + fee.amount, 0n);
}

/** Subunits as a USD string for an allowlisted peg, or empty. Exact: decimal.js-light. */
export function usdOf(coin: string, subunits: bigint): string {
  const decimals = usdDecimalsOf(coin);
  if (decimals === undefined) {
    return '';
  }
  return new Decimal(subunits.toString()).div(new Decimal(10).pow(decimals)).toString();
}

/** Count, sum and sort: the report for `window`. */
export function aggregate(
  candidates: readonly Candidate[],
  context: readonly ContextCount[],
  window: Window = {},
): StatsReport {
  const sorted = [...candidates].sort(byChainPosition);
  const seen = new Set<string>();
  const purchases = new Map<string, PurchaseTotals>();
  const fees = new Map<string, FeeTotals>();
  for (const candidate of sorted) {
    const duplicate = seen.has(candidate.reference);
    seen.add(candidate.reference);
    if (!inWindow(candidate.day, window)) {
      continue;
    }
    const key = [
      candidate.day,
      candidate.rail,
      candidate.network,
      candidate.coin,
      candidate.payout,
    ].join('\n');
    const totals = purchases.get(key) ?? {
      day: candidate.day,
      rail: candidate.rail,
      network: candidate.network,
      coin: candidate.coin,
      payout: candidate.payout,
      count: 0,
      provider: 0n,
      fee: 0n,
      duplicates: 0,
      duplicateGross: 0n,
    };
    purchases.set(key, totals);
    const fee = feeTotal(candidate);
    if (duplicate) {
      totals.duplicates += 1;
      totals.duplicateGross += candidate.provider + fee;
      continue;
    }
    totals.count += 1;
    totals.provider += candidate.provider;
    totals.fee += fee;
    for (const leg of candidate.fees) {
      const feeKey = [
        candidate.day,
        candidate.rail,
        candidate.network,
        candidate.coin,
        leg.treasury,
      ].join('\n');
      const feeTotals = fees.get(feeKey) ?? {
        day: candidate.day,
        rail: candidate.rail,
        network: candidate.network,
        coin: candidate.coin,
        treasury: leg.treasury,
        count: 0,
        amount: 0n,
      };
      feeTotals.count += 1;
      feeTotals.amount += leg.amount;
      fees.set(feeKey, feeTotals);
    }
  }
  const contextTotals = new Map<string, ContextRow>();
  for (const entry of context) {
    if (!inWindow(entry.day, window)) {
      continue;
    }
    const key = [entry.day, entry.rail, entry.bucket].join('\n');
    const row = contextTotals.get(key) ?? {
      day: entry.day,
      rail: entry.rail,
      bucket: entry.bucket,
      count: 0,
    };
    row.count += entry.count;
    contextTotals.set(key, row);
  }
  return {
    purchases: [...purchases.values()].sort(byRowKey).map((totals) => ({
      day: totals.day,
      rail: totals.rail,
      network: totals.network,
      coin: totals.coin,
      payout: totals.payout,
      count: totals.count,
      gross_subunits: (totals.provider + totals.fee).toString(),
      gross_usd: usdOf(totals.coin, totals.provider + totals.fee),
      provider_subunits: totals.provider.toString(),
      fee_subunits: totals.fee.toString(),
      duplicate_transfers: totals.duplicates,
      duplicate_subunits: totals.duplicateGross.toString(),
    })),
    fees: [...fees.values()].sort(byRowKey).map((totals) => ({
      day: totals.day,
      rail: totals.rail,
      network: totals.network,
      coin: totals.coin,
      treasury: totals.treasury,
      fee_count: totals.count,
      fee_subunits: totals.amount.toString(),
      fee_usd: usdOf(totals.coin, totals.amount),
    })),
    context: [...contextTotals.values()].sort(byRowKey),
  };
}

/** Rows in a stable order: day, rail, then what tells them apart. */
function byRowKey(
  left: {
    day: string;
    rail: string;
    coin?: string;
    payout?: string;
    treasury?: string;
    bucket?: string;
  },
  right: {
    day: string;
    rail: string;
    coin?: string;
    payout?: string;
    treasury?: string;
    bucket?: string;
  },
): number {
  const keyOf = (row: typeof left) => [
    row.day,
    row.rail,
    row.coin ?? '',
    row.payout ?? row.treasury ?? row.bucket ?? '',
  ];
  const leftKey = keyOf(left);
  const rightKey = keyOf(right);
  for (const [index, part] of leftKey.entries()) {
    const other = rightKey[index] ?? '';
    if (part !== other) {
      return part < other ? -1 : 1;
    }
  }
  return 0;
}

/** The UTC day of a unix time in seconds, `YYYY-MM-DD`. */
export function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
