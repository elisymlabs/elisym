import type { NetworkStats } from '@elisym/sdk';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useElisymClient } from './useElisymClient';

/** Keep the max of each stat field */
function mergeMax(prev: NetworkStats, next: NetworkStats): NetworkStats {
  return {
    totalAgentCount: Math.max(prev.totalAgentCount, next.totalAgentCount),
    agentCount: Math.max(prev.agentCount, next.agentCount),
    jobCount: Math.max(prev.jobCount, next.jobCount),
    totalLamports: Math.max(prev.totalLamports, next.totalLamports),
  };
}

const ZERO: NetworkStats = { totalAgentCount: 0, agentCount: 0, jobCount: 0, totalLamports: 0 };

export function useStats() {
  const { client } = useElisymClient();
  const highWater = useRef<NetworkStats>(ZERO);

  return useQuery<NetworkStats>({
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

      const stats: NetworkStats = {
        totalAgentCount,
        agentCount: totalAgentCount,
        jobCount: completedJobs.length,
        totalLamports,
      };

      highWater.current = mergeMax(highWater.current, stats);
      return highWater.current;
    },
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
