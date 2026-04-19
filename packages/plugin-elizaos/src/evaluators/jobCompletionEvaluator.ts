import type { Evaluator, IAgentRuntime } from '@elizaos/core';
import { ACTIVE_JOBS_TTL_MS } from '../constants';
import { logger } from '../lib/logger';
import { formatLamportsAsSol } from '../lib/pricing';
import { getState, hasState } from '../state';

export const jobCompletionEvaluator: Evaluator = {
  name: 'ELISYM_JOB_COMPLETION',
  description: 'Logs outcomes of completed elisym jobs for future planning context.',
  similes: [],
  alwaysRun: false,
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    if (!hasState(runtime)) {
      return false;
    }
    const { activeJobs } = getState(runtime);
    const now = Date.now();
    for (const job of activeJobs.values()) {
      if (job.status === 'success' || job.status === 'error') {
        return true;
      }
      if (now - job.lastUpdate > ACTIVE_JOBS_TTL_MS) {
        return true;
      }
    }
    return false;
  },
  handler: async (runtime): Promise<void> => {
    if (!hasState(runtime)) {
      return;
    }
    const { activeJobs } = getState(runtime);
    const now = Date.now();
    for (const [id, job] of activeJobs) {
      const isTerminal =
        job.status === 'success' || job.status === 'error' || job.status === 'cancelled';
      const isStuck = now - job.lastUpdate > ACTIVE_JOBS_TTL_MS;
      if (isTerminal) {
        logger.info(
          {
            jobId: id,
            status: job.status,
            lamports: formatLamportsAsSol(job.lamports),
            tx: job.txSignature,
          },
          'elisym job finalized',
        );
        job.cleanup?.();
        activeJobs.delete(id);
        continue;
      }
      if (isStuck) {
        logger.warn(
          {
            jobId: id,
            status: job.status,
            ageMs: now - job.lastUpdate,
          },
          'evicting stuck activeJob (TTL exceeded)',
        );
        job.cleanup?.();
        activeJobs.delete(id);
      }
    }
  },
  examples: [],
};
