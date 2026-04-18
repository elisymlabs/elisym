import type { Provider } from '@elizaos/core';
import { hasState, getState } from '../state';

export const activeJobsProvider: Provider = {
  name: 'ELISYM_ACTIVE_JOBS',
  description: 'Lists currently pending and active elisym jobs to prevent duplicate hires.',
  position: 80,
  dynamic: true,
  get: async (runtime) => {
    if (!hasState(runtime)) {
      return { text: '', values: {}, data: {} };
    }
    const { activeJobs } = getState(runtime);
    if (activeJobs.size === 0) {
      return { text: 'No active elisym jobs.', values: { count: 0 }, data: {} };
    }
    const lines = Array.from(activeJobs.values()).map(
      (job) => `- ${job.id.slice(0, 8)} (${job.capability}, ${job.status})`,
    );
    return {
      text: ['Active elisym jobs:', ...lines].join('\n'),
      values: { count: activeJobs.size },
      data: {},
    };
  },
};
