import type { Action, ActionResult, IAgentRuntime } from '@elizaos/core';
import { pruneOldEntries } from '../lib/jobLedger';
import { hasState } from '../state';

export const cleanupJobsAction: Action = {
  name: 'ELISYM_CLEANUP_JOBS',
  similes: ['PRUNE_JOBS', 'CLEANUP_LEDGER'],
  description:
    'Force-run the elisym job-ledger pruner. Removes terminal entries past JOB_LEDGER_RETENTION_MS.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => hasState(runtime),
  handler: async (runtime, _message, _state, _options, callback): Promise<ActionResult> => {
    const deleted = await pruneOldEntries(runtime);
    const noun = deleted === 1 ? 'entry' : 'entries';
    const text = `Pruned ${deleted} terminal job ledger ${noun}.`;
    await callback?.({ text, source: 'elisym' });
    return { success: true, data: { deleted } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Prune the elisym job ledger' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pruning terminal entries...',
          actions: ['ELISYM_CLEANUP_JOBS'],
        },
      },
    ],
  ],
};
