import { useCallback, useSyncExternalStore } from 'react';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import {
  flipTerminal as storeFlipTerminal,
  readJobs,
  saveJob as storeSaveJob,
  subscribeJobHistory,
  unseenJobsCount,
  updateJob as storeUpdateJob,
  type StoredJob,
} from '~/lib/jobHistory';

export type { StoredJob } from '~/lib/jobHistory';

/**
 * Thin `useSyncExternalStore` view over the shared job-history store
 * (`~/lib/jobHistory`). The callbacks close over `wallet`, so a caller that
 * snapshots them (BuyContext's mid-job closures) keeps writing under the
 * wallet the job was bought with even if the wallet disconnects mid-job.
 */
export function useJobHistory({ wallet }: { wallet: string }) {
  const jobs = useSyncExternalStore(subscribeJobHistory, () => readJobs(wallet));

  const saveJob = useCallback((job: StoredJob) => storeSaveJob(wallet, job), [wallet]);

  const updateJob = useCallback(
    (jobEventId: string, patch: Partial<StoredJob>) => storeUpdateJob(wallet, jobEventId, patch),
    [wallet],
  );

  /** Terminal flip with the store-side freshly-read-row guard (plan decision 4/5). */
  const flipJob = useCallback(
    (jobEventId: string, patch: Partial<StoredJob>, opts: { stampUnseen: boolean }) =>
      storeFlipTerminal(wallet, jobEventId, patch, opts),
    [wallet],
  );

  return { jobs, saveJob, updateJob, flipJob };
}

/** Live `unseen` badge count for the header (number snapshots are stable). */
export function useUnseenJobsCount(wallet: string): number {
  return useSyncExternalStore(subscribeJobHistory, () => unseenJobsCount(wallet, SOLANA_CLUSTER));
}
