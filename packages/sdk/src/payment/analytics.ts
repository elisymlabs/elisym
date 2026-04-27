import type { Rpc, Signature, SolanaRpcApi } from '@solana/kit';
import { address } from '@solana/kit';
import { DEFAULTS, ELISYM_PROTOCOL_TAG } from '../constants';

/**
 * Aggregated on-chain stats across the entire elisym network. Volume is
 * keyed by `'native'` for SOL or by SPL mint address; values are subunits
 * (lamports for native, raw token units for SPL).
 */
export interface NetworkStatsResult {
  jobCount: number;
  volumeByAsset: Record<string, bigint>;
  /** Most-recent signature returned by the RPC (use as cursor for forward sync). */
  latestSignature?: string;
  /** Oldest signature scanned in this batch (use as `before` for next page). */
  oldestSignature?: string;
}

export interface AggregateNetworkStatsOptions {
  /** Cap on signatures fetched in one call. Defaults to 1000 (RPC max). */
  limit?: number;
  /** Page backwards from this signature for historical scans. */
  before?: Signature;
  /** Parallel `getTransaction` calls. Defaults to `DEFAULTS.QUERY_MAX_CONCURRENCY`. */
  concurrency?: number;
}

const DEFAULT_LIMIT = 1000;
const NATIVE_KEY = 'native';

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/**
 * Enumerate every elisym payment transaction reachable from the protocol tag
 * pubkey and aggregate gross volume + count.
 *
 * Implementation detail: for SPL txs we sum positive token-balance deltas per
 * mint (ignores ATA rent that would inflate native lamport deltas in the same
 * tx). For native SOL txs we sum positive lamport deltas across all non-payer
 * accounts - elisym native txs only emit provider + optional fee transfers,
 * so this equals gross volume. The `tx_fee` paid by the fee-payer never shows
 * up as a positive delta, so it is naturally excluded.
 */
export async function aggregateNetworkStats(
  rpc: Rpc<SolanaRpcApi>,
  options?: AggregateNetworkStatsOptions,
): Promise<NetworkStatsResult> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const concurrency = options?.concurrency ?? DEFAULTS.QUERY_MAX_CONCURRENCY;
  const tag = address(ELISYM_PROTOCOL_TAG);

  const signatures = await rpc
    .getSignaturesForAddress(tag, { limit, before: options?.before })
    .send();
  const validSigs = signatures.filter((entry) => entry.err === null);

  if (validSigs.length === 0) {
    return { jobCount: 0, volumeByAsset: {} };
  }

  const volumeByAsset: Record<string, bigint> = {};
  let jobCount = 0;

  for (let start = 0; start < validSigs.length; start += concurrency) {
    const batch = validSigs.slice(start, start + concurrency);
    const txResults = await Promise.all(
      batch.map((entry) =>
        rpc
          .getTransaction(entry.signature, {
            commitment: 'confirmed',
            encoding: 'json',
            maxSupportedTransactionVersion: 0,
          })
          .send()
          .catch(() => null),
      ),
    );

    for (const tx of txResults) {
      if (!tx?.meta || tx.meta.err) {
        continue;
      }
      jobCount += 1;
      accumulateTransfers(tx, volumeByAsset);
    }
  }

  const latest = validSigs[0]?.signature;
  const oldest = validSigs.at(-1)?.signature;

  return {
    jobCount,
    volumeByAsset,
    latestSignature: latest as string | undefined,
    oldestSignature: oldest as string | undefined,
  };
}

interface RawTransaction {
  meta: {
    err: unknown;
    preBalances: readonly bigint[];
    postBalances: readonly bigint[];
    preTokenBalances?: readonly TokenBalanceEntry[];
    postTokenBalances?: readonly TokenBalanceEntry[];
  } | null;
  transaction: {
    message: {
      accountKeys: readonly string[];
    };
  };
}

function accumulateTransfers(tx: unknown, volumeByAsset: Record<string, bigint>): void {
  const raw = tx as RawTransaction;
  const meta = raw.meta;
  if (!meta) {
    return;
  }

  const preTokens = meta.preTokenBalances ?? [];
  const postTokens = meta.postTokenBalances ?? [];
  const isSpl = postTokens.length > 0 || preTokens.length > 0;

  if (isSpl) {
    accumulateSplDeltas(preTokens, postTokens, volumeByAsset);
    return;
  }

  accumulateNativeDeltas(meta.preBalances, meta.postBalances, volumeByAsset);
}

function accumulateSplDeltas(
  pre: readonly TokenBalanceEntry[],
  post: readonly TokenBalanceEntry[],
  volumeByAsset: Record<string, bigint>,
): void {
  for (const postEntry of post) {
    const preEntry = pre.find((entry) => entry.accountIndex === postEntry.accountIndex);
    const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
    const postAmount = BigInt(postEntry.uiTokenAmount.amount);
    const delta = postAmount - preAmount;
    if (delta > 0n) {
      volumeByAsset[postEntry.mint] = (volumeByAsset[postEntry.mint] ?? 0n) + delta;
    }
  }
}

function accumulateNativeDeltas(
  pre: readonly bigint[],
  post: readonly bigint[],
  volumeByAsset: Record<string, bigint>,
): void {
  // accountKeys[0] is the fee payer; its negative delta covers gross + tx_fee.
  // Skip it and sum positive deltas of every other account - equals gross.
  for (let i = 1; i < post.length; i++) {
    const preValue = pre[i] ?? 0n;
    const postValue = post[i] ?? 0n;
    const delta = BigInt(postValue) - BigInt(preValue);
    if (delta > 0n) {
      volumeByAsset[NATIVE_KEY] = (volumeByAsset[NATIVE_KEY] ?? 0n) + delta;
    }
  }
}
