import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import type { Network } from '../types';

const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 1_000n;
/**
 * Ceiling on the RPC-derived estimate. A malicious or misconfigured RPC can
 * return arbitrarily large prioritization-fee samples; without a bound the
 * estimate flows into `setTransactionMessageComputeUnitPrice` and the user
 * pays it. 5M microLamports/CU at the default 200k CU limit caps priority
 * gas at 0.001 SOL - generous for real congestion, harmless as a bound.
 * Callers that genuinely need more pass `priorityFeeMicroLamports` explicitly
 * (the override never goes through this estimator).
 */
const PRIORITY_FEE_CEILING_MICROLAMPORTS = 5_000_000n;
const DEFAULT_PERCENTILE = 75;
const DEFAULT_CACHE_TTL_MS = 10_000;

interface CacheEntry {
  microLamports: bigint;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

export interface EstimatePriorityFeeOptions {
  /**
   * The cluster the supplied RPC points at. Cache discriminator - fee samples
   * from one cluster must never serve an estimate for the other, and nothing
   * else in the inputs identifies the cluster (accounts and percentiles are
   * cluster-agnostic).
   */
  network: Network;
  /**
   * Percentile of the recent prioritization-fee distribution to charge.
   * 50 = median, 75 = upper quartile, 90 = aggressive. Defaults to 75.
   */
  percentile?: number;
  /**
   * Cache window in milliseconds. Subsequent calls within this window with the
   * same accounts will return the cached value. Defaults to 10s.
   */
  ttlMs?: number;
  /**
   * Optional account list passed to `getRecentPrioritizationFees` so the node
   * returns fees observed on writes touching these accounts. Empty = global.
   */
  accounts?: readonly Address[];
}

/**
 * Estimate a per-compute-unit priority fee from recent blocks, in
 * microLamports (1 microLamport = 0.000001 Lamports).
 *
 * Falls back to a 1000 microLamport floor when the RPC returns no samples
 * (typical on private clusters or under maintenance), and clamps to a 5M
 * microLamport ceiling so a hostile RPC cannot inflate the fee arbitrarily.
 * Negative percentiles are clamped to the median.
 *
 * Cached per (network, accounts)-key for `ttlMs` (default 10s) using the same
 * in-process cache pattern as `getProtocolConfig` - `options.network` is
 * required because nothing else in the inputs identifies the cluster.
 */
export async function estimatePriorityFeeMicroLamports(
  rpc: Rpc<SolanaRpcApi>,
  options: EstimatePriorityFeeOptions,
): Promise<bigint> {
  const percentile = clampPercentile(options.percentile ?? DEFAULT_PERCENTILE);
  const ttl = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const accounts = options.accounts ?? [];
  const key = cacheKey(options.network, percentile, accounts);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now < cached.expires) {
    return cached.microLamports;
  }

  const samples = await rpc.getRecentPrioritizationFees(accounts).send();
  const fee = pickPercentileFee(samples, percentile);
  cache.set(key, { microLamports: fee, expires: now + ttl });
  return fee;
}

export function clearPriorityFeeCache(): void {
  cache.clear();
}

interface RecentPrioritizationFeeLike {
  prioritizationFee: bigint | number;
  slot?: bigint | number;
}

export function pickPercentileFee(
  samples: readonly RecentPrioritizationFeeLike[],
  percentile: number,
): bigint {
  if (samples.length === 0) {
    return PRIORITY_FEE_FLOOR_MICROLAMPORTS;
  }
  const sorted = samples.map((sample) => BigInt(sample.prioritizationFee)).sort(compareBigInt);
  const clamped = clampPercentile(percentile);
  const indexFloat = ((clamped / 100) * (sorted.length - 1)) | 0;
  const value = sorted[indexFloat];
  if (value < PRIORITY_FEE_FLOOR_MICROLAMPORTS) {
    return PRIORITY_FEE_FLOOR_MICROLAMPORTS;
  }
  if (value > PRIORITY_FEE_CEILING_MICROLAMPORTS) {
    return PRIORITY_FEE_CEILING_MICROLAMPORTS;
  }
  return value;
}

function clampPercentile(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PERCENTILE;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function cacheKey(network: Network, percentile: number, accounts: readonly Address[]): string {
  if (accounts.length === 0) {
    return `${network}:p:${percentile}`;
  }
  return `${network}:p:${percentile}:${[...accounts].sort().join(',')}`;
}
