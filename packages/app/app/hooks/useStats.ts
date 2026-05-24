import { getNetworkStats, getProtocolProgramId } from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { SDK_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { useLocalQuery } from './useLocalQuery';

/**
 * Stats sourced from the on-chain `NetworkStats` PDA maintained by the
 * elisym-config program. One `getAccountInfo` per refetch - no signature
 * scans, no per-tx aggregation, no watermark heuristics.
 *
 * IMPORTANT: this is a best-effort, self-reported counter, NOT an authoritative
 * figure. The PDA is bumped by clients alongside payments; nothing verifies the
 * increments against the real token transfers, so the counter can be inflated
 * by a misbehaving or malicious client. Treat these numbers as approximate and
 * label them as such in the UI. A verified figure would require aggregating
 * actual on-chain transfers (see `aggregateNetworkStats`), which is far too slow
 * for this view.
 */
export interface UiNetworkStats {
  jobCount: number;
  /** Total volume in lamports (1e9 = 1 SOL). */
  totalLamports: number;
  /** Total volume in USDC subunits (1e6 = 1 USDC). */
  totalUsdcMicro: number;
}

const onchainRpc = createSolanaRpc(SOLANA_RPC_URL);
const PROTOCOL_PROGRAM_ID = getProtocolProgramId(SDK_CLUSTER);

const EMPTY_STATS: UiNetworkStats = {
  jobCount: 0,
  totalLamports: 0,
  totalUsdcMicro: 0,
};

async function fetchOnchainStats(): Promise<UiNetworkStats> {
  const stats = await getNetworkStats(onchainRpc, PROTOCOL_PROGRAM_ID);
  if (!stats) {
    return EMPTY_STATS;
  }
  return {
    jobCount: stats.jobCount,
    totalLamports: Number(stats.volumeNative),
    totalUsdcMicro: Number(stats.volumeUsdc),
  };
}

export function useStats() {
  return useLocalQuery<UiNetworkStats>({
    queryKey: ['network-stats'],
    queryFn: fetchOnchainStats,
    retry: 3,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 3_000),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
