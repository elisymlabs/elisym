import { USDC_SOLANA_DEVNET, type NetworkStats } from '@elisym/sdk';
import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js-light';
import { useRef } from 'react';
import { useElisymClient } from './useElisymClient';

/**
 * UI-side stats shape that augments NetworkStats with per-asset volumes.
 * SDK exposes asset on each Job since 0.10.x; we bucket by `asset.mint`
 * (USDC mint -> totalUsdcMicro, otherwise -> totalLamports).
 */
export interface UiNetworkStats extends NetworkStats {
  /** Total volume in USDC subunits (1e6 = 1 USDC). */
  totalUsdcMicro: number;
}

/** Keep the max of each stat field */
function mergeMax(prev: UiNetworkStats, next: UiNetworkStats): UiNetworkStats {
  return {
    totalAgentCount: Math.max(prev.totalAgentCount, next.totalAgentCount),
    agentCount: Math.max(prev.agentCount, next.agentCount),
    jobCount: Math.max(prev.jobCount, next.jobCount),
    totalLamports: Math.max(prev.totalLamports, next.totalLamports),
    totalUsdcMicro: Math.max(prev.totalUsdcMicro, next.totalUsdcMicro),
  };
}

const ZERO: UiNetworkStats = {
  totalAgentCount: 0,
  agentCount: 0,
  jobCount: 0,
  totalLamports: 0,
  totalUsdcMicro: 0,
};

export function useStats() {
  const { client } = useElisymClient();
  const highWater = useRef<UiNetworkStats>(ZERO);

  return useQuery<UiNetworkStats>({
    queryKey: ['network-stats'],
    queryFn: async () => {
      const totalAgentCount = await client.discovery.fetchAllAgentCount();

      const jobs = await client.marketplace.fetchRecentJobs(
        undefined,
        undefined,
        Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
      );

      const completedJobs = jobs.filter((j) => j.status === 'success');
      // Aggregate via decimal.js-light so 6-decimal USDC subunits don't lose
      // precision once the volume hits 2^53. Convert to Number only when
      // writing the stats payload that the StatsBar consumes.
      let lamports = new Decimal(0);
      let usdcMicro = new Decimal(0);
      for (const job of completedJobs) {
        if (!job.amount) {
          continue;
        }
        const isUsdc = job.asset?.mint === USDC_SOLANA_DEVNET.mint;
        if (isUsdc) {
          usdcMicro = usdcMicro.plus(job.amount);
        } else {
          lamports = lamports.plus(job.amount);
        }
      }

      const stats: UiNetworkStats = {
        totalAgentCount,
        agentCount: totalAgentCount,
        jobCount: completedJobs.length,
        totalLamports: Number(lamports.toString()),
        totalUsdcMicro: Number(usdcMicro.toString()),
      };

      highWater.current = mergeMax(highWater.current, stats);
      return highWater.current;
    },
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
