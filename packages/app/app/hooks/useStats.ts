import { USDC_SOLANA_DEVNET, aggregateNetworkStats } from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { SOLANA_RPC_URL } from '~/lib/cluster';
import { useLocalQuery } from './useLocalQuery';

/**
 * Stats derived from the protocol tag's tx index. Volume + jobCount come
 * from the SDK's `aggregateNetworkStats` helper, which enumerates every
 * elisym payment tx via `getSignaturesForAddress(ELISYM_PROTOCOL_TAG)` -
 * one tag = one network-wide index, independent of fee size or recipient.
 * Captures fee=0 jobs that the previous treasury-balance projection silently
 * dropped.
 */
export interface UiNetworkStats {
  jobCount: number;
  /** Total volume in lamports (1e9 = 1 SOL). */
  totalLamports: number;
  /** Total volume in USDC subunits (1e6 = 1 USDC). */
  totalUsdcMicro: number;
}

const onchainRpc = createSolanaRpc(SOLANA_RPC_URL);

// Stats sourced from on-chain history are monotonically non-decreasing. Hold a
// per-session high-water mark so transient RPC dips (rate limits, partial
// indexer responses) never make the UI flicker backwards.
const statsWatermark: UiNetworkStats = {
  jobCount: 0,
  totalLamports: 0,
  totalUsdcMicro: 0,
};

function mergeWithWatermark(next: UiNetworkStats): UiNetworkStats {
  statsWatermark.jobCount = Math.max(statsWatermark.jobCount, next.jobCount);
  statsWatermark.totalLamports = Math.max(statsWatermark.totalLamports, next.totalLamports);
  statsWatermark.totalUsdcMicro = Math.max(statsWatermark.totalUsdcMicro, next.totalUsdcMicro);
  return { ...statsWatermark };
}

async function fetchOnchainStats(): Promise<UiNetworkStats> {
  const result = await aggregateNetworkStats(onchainRpc);
  const usdcMint = USDC_SOLANA_DEVNET.mint;
  const lamports = result.volumeByAsset.native ?? 0n;
  const usdc = usdcMint ? (result.volumeByAsset[usdcMint] ?? 0n) : 0n;
  return mergeWithWatermark({
    jobCount: result.jobCount,
    totalLamports: Number(lamports),
    totalUsdcMicro: Number(usdc),
  });
}

export function useStats() {
  return useLocalQuery<UiNetworkStats>({
    queryKey: ['network-stats'],
    queryFn: fetchOnchainStats,
    cacheTransform: mergeWithWatermark,
    retry: 3,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 3_000),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
