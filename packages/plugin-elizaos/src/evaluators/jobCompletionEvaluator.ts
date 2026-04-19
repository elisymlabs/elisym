import type { Evaluator, IAgentRuntime } from '@elizaos/core';
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
    for (const job of getState(runtime).activeJobs.values()) {
      if (job.status === 'success' || job.status === 'error') {
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
    for (const [id, job] of activeJobs) {
      if (job.status === 'success' || job.status === 'error' || job.status === 'cancelled') {
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
      }
    }
  },
  examples: [],
};
