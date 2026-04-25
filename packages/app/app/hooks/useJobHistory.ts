import { useState, useEffect, useCallback } from 'react';

export interface StoredJob {
  jobEventId: string;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  capability: string;
  status: string;
  paymentAmount?: number;
  txHash?: string;
  result?: string;
  createdAt: number;
}

const STORAGE_KEY = 'elisym:job-history';

function loadJobs(wallet: string): StoredJob[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${wallet}`);
    return raw ? (JSON.parse(raw) as StoredJob[]) : [];
  } catch {
    return [];
  }
}

function persistJobs(wallet: string, jobs: StoredJob[]) {
  localStorage.setItem(`${STORAGE_KEY}:${wallet}`, JSON.stringify(jobs));
}

export function useJobHistory({ wallet }: { wallet: string }) {
  const [jobs, setJobs] = useState<StoredJob[]>(() => (wallet ? loadJobs(wallet) : []));

  useEffect(() => {
    setJobs(wallet ? loadJobs(wallet) : []);
  }, [wallet]);

  const saveJob = useCallback(
    (job: StoredJob) => {
      if (!wallet) {
        return;
      }
      setJobs((prev) => {
        const next = [job, ...prev.filter((j) => j.jobEventId !== job.jobEventId)];
        persistJobs(wallet, next);
        return next;
      });
    },
    [wallet],
  );

  const updateJob = useCallback(
    (jobEventId: string, patch: Partial<StoredJob>) => {
      if (!wallet) {
        return;
      }
      setJobs((prev) => {
        const next = prev.map((j) => (j.jobEventId === jobEventId ? { ...j, ...patch } : j));
        persistJobs(wallet, next);
        return next;
      });
    },
    [wallet],
  );

  return { jobs, saveJob, updateJob };
}
