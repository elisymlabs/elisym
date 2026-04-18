import type { Action, IAgentRuntime } from '@elizaos/core';
import { formatLamportsAsSol } from '../lib/pricing';
import { getState, hasState } from '../state';

export const listActiveJobsAction: Action = {
  name: 'ELISYM_LIST_JOBS',
  similes: ['SHOW_JOBS', 'MY_JOBS'],
  description: 'List currently active and recent elisym jobs.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => hasState(runtime),
  handler: async (runtime, _message, _state, _options, callback): Promise<unknown> => {
    const { activeJobs } = getState(runtime);
    if (activeJobs.size === 0) {
      await callback?.({ text: 'No active elisym jobs.', source: 'elisym' });
      return { count: 0 };
    }
    const lines = Array.from(activeJobs.values()).map((job) => {
      const ageSec = Math.round((Date.now() - job.createdAt) / 1000);
      return `- ${job.id.slice(0, 8)} (${job.capability}) ${job.status} | ${formatLamportsAsSol(job.lamports)} SOL | ${ageSec}s ago`;
    });
    const text = ['Elisym jobs:', ...lines].join('\n');
    await callback?.({ text, source: 'elisym' });
    return { count: activeJobs.size };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'List my elisym jobs' } },
      {
        name: '{{agent}}',
        content: { text: 'Listing jobs...', actions: ['ELISYM_LIST_JOBS'] },
      },
    ],
  ],
};
