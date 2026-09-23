import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useIdentity } from '~/hooks/useIdentity';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import {
  flipTerminal as storeFlipTerminal,
  migrateLegacyJobHistory,
  readJobs,
  saveJob as storeSaveJob,
  subscribeJobHistory,
  unseenJobsCount,
  updateJob as storeUpdateJob,
  type StoredJob,
} from '~/lib/jobHistory';

export type { StoredJob } from '~/lib/jobHistory';

/**
 * The one-time copy off the old wallet-keyed store, in an effect rather than in
 * `readJobs`: a `useSyncExternalStore` snapshot must not write, or the notify
 * it triggers re-enters the render it was called from. Idempotent and marked,
 * so it runs once per identity however many components mount.
 */
function useJobHistoryMigration(owner: string, providerSession: boolean): void {
  useEffect(() => {
    // A pasted provider key is somebody else's identity on this machine; it has
    // no claim on what this browser's customer bought. The copy waits for a key
    // this browser generated - and the marker is written only when it happens.
    if (!providerSession) {
      migrateLegacyJobHistory(owner);
    }
  }, [owner, providerSession]);
}

/**
 * Thin `useSyncExternalStore` view over the shared job-history store
 * (`~/lib/jobHistory`), scoped to the ACTIVE NOSTR IDENTITY.
 *
 * The callbacks close over that identity, so a caller that snapshots them
 * (BuyContext's mid-job closures) keeps writing under the identity the job was
 * bought with even if the user switches identity mid-job - the same guarantee
 * the wallet-keyed version gave, now about the thing that actually owns the job.
 */
export function useJobHistory() {
  const { publicKey: owner, providerSession } = useIdentity();
  useJobHistoryMigration(owner, providerSession);
  const jobs = useSyncExternalStore(subscribeJobHistory, () => readJobs(owner));

  const saveJob = useCallback((job: StoredJob) => storeSaveJob(owner, job), [owner]);

  const updateJob = useCallback(
    (jobEventId: string, patch: Partial<StoredJob>) => storeUpdateJob(owner, jobEventId, patch),
    [owner],
  );

  /** Terminal flip with the store-side freshly-read-row guard (plan decision 4/5). */
  const flipJob = useCallback(
    (jobEventId: string, patch: Partial<StoredJob>, opts: { stampUnseen: boolean }) =>
      storeFlipTerminal(owner, jobEventId, patch, opts),
    [owner],
  );

  return { owner, jobs, saveJob, updateJob, flipJob };
}

/** Live `unseen` badge count for the header (number snapshots are stable). */
export function useUnseenJobsCount(): number {
  const { publicKey: owner, providerSession } = useIdentity();
  useJobHistoryMigration(owner, providerSession);
  return useSyncExternalStore(subscribeJobHistory, () => unseenJobsCount(owner, SOLANA_CLUSTER));
}
