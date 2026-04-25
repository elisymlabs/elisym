import type { NetworkStats } from '@elisym/sdk';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useElisymClient } from './useElisymClient';

/**
 * UI-side stats shape that augments NetworkStats with per-asset volumes.
 * SDK currently aggregates a single `totalLamports`, so USDC volume is mocked
 * here until the SDK separates volume by asset.
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
      let totalLamports = 0;
      for (const j of completedJobs) {
        if (j.amount) {
          totalLamports += j.amount;
        }
      }

      // TODO: replace with real per-asset volume once SDK exposes it.
      // Derived placeholder so the USDC switcher in the hero isn't always 0.
      const totalUsdcMicro = Math.floor(totalLamports / 1000);

      const stats: UiNetworkStats = {
        totalAgentCount,
        agentCount: totalAgentCount,
        jobCount: completedJobs.length,
        totalLamports,
        totalUsdcMicro,
      };

      highWater.current = mergeMax(highWater.current, stats);
      return highWater.current;
    },
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
