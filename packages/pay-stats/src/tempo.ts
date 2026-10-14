/**
 * Tempo: every marked commerce transfer, per token, per hour, from the marker
 * launch to the finalized head.
 *
 * A transfer is marked when its memo is the commerce magic plus 28 bytes
 * (`isTempoCommerceMemo`). The legs of one transaction under one memo are one
 * payment: the largest leg to an address that is not a known treasury is the
 * provider's, legs to a known EVM treasury are fees, any other leg is extra. A
 * payment with only treasury legs is never a purchase (`treasury_only`).
 */
import { TEMPO_COMMERCE_MEMO_MAGIC, assetsFor, isTempoCommerceMemo } from '@elisym/pay-core';
import {
  type Eip1193Client,
  type TempoTransferLog,
  listTempoMarkedTransfers,
} from '@elisym/pay-core/evm';
import type { Candidate, ContextCount, StatsNetwork } from './aggregate';
import type { HourRange } from './tempo-days';
import { coinOf } from './usd';

/** Retries of an hour whose scan came back incomplete, before its day is flagged. */
export const HOUR_RETRIES = 3;

export interface TempoScan {
  candidates: Candidate[];
  context: ContextCount[];
  /** Days with an hour still incomplete after its retries. */
  incompleteDays: Set<string>;
}

/** One hour of one token: every marked transfer, retried while the scan is incomplete. */
async function scanHour(
  client: Eip1193Client,
  token: string,
  range: HourRange,
): Promise<{ logs: TempoTransferLog[]; complete: boolean }> {
  const logs = new Map<string, TempoTransferLog>();
  for (let attempt = 0; attempt <= HOUR_RETRIES; attempt += 1) {
    const scan = await listTempoMarkedTransfers(client, {
      token,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      memoPrefix: TEMPO_COMMERCE_MEMO_MAGIC,
    });
    for (const log of scan.candidates) {
      logs.set(`${log.transactionHash}:${log.logIndex}`, log);
    }
    if (scan.complete) {
      return { logs: [...logs.values()], complete: true };
    }
  }
  return { logs: [...logs.values()], complete: false };
}

/** The payments of one hour's logs of one token: grouped by (transaction, memo). */
export function tempoCandidates(
  logs: readonly TempoTransferLog[],
  network: StatsNetwork,
  day: string,
  treasuries: ReadonlySet<string>,
): { candidates: Candidate[]; context: ContextCount[] } {
  const groups = new Map<string, TempoTransferLog[]>();
  for (const log of logs) {
    if (log.memo === undefined || !isTempoCommerceMemo(log.memo)) {
      continue;
    }
    const key = `${log.transactionHash}:${log.memo}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  const candidates: Candidate[] = [];
  const context: ContextCount[] = [];
  for (const legs of groups.values()) {
    let provider: TempoTransferLog | undefined;
    const fees: { treasury: string; amount: bigint }[] = [];
    for (const leg of legs) {
      if (treasuries.has(leg.to)) {
        fees.push({ treasury: leg.to, amount: leg.amount });
      } else if (provider === undefined || leg.amount > provider.amount) {
        provider = leg;
      }
    }
    if (provider === undefined || provider.memo === undefined) {
      context.push({ day, rail: 'tempo', bucket: 'treasury_only', count: 1 });
      continue;
    }
    candidates.push({
      rail: 'tempo',
      network,
      reference: provider.memo,
      day,
      position: { primary: provider.blockNumber, secondary: provider.logIndex },
      coin: coinOf('tempo', network, provider.token),
      payout: provider.to,
      provider: provider.amount,
      fees,
    });
  }
  return { candidates, context };
}

/** Scan every registry token of the network over `ranges`. */
export async function scanTempo(
  client: Eip1193Client,
  network: StatsNetwork,
  ranges: readonly HourRange[],
  treasuries: ReadonlySet<string>,
): Promise<TempoScan> {
  const result: TempoScan = { candidates: [], context: [], incompleteDays: new Set() };
  const tokens = assetsFor('tempo', network).flatMap((asset) =>
    asset.mint === undefined ? [] : [asset.mint.toLowerCase()],
  );
  for (const token of tokens) {
    for (const range of ranges) {
      const hour = await scanHour(client, token, range);
      if (!hour.complete) {
        result.incompleteDays.add(range.day);
        result.context.push({
          day: range.day,
          rail: 'tempo',
          bucket: 'incomplete_hours',
          count: 1,
        });
      }
      const found = tempoCandidates(hour.logs, network, range.day, treasuries);
      result.candidates.push(...found.candidates);
      result.context.push(...found.context);
    }
  }
  return result;
}
