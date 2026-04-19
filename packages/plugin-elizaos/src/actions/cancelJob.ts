import type { Action, ActionResult, IAgentRuntime } from '@elizaos/core';
import { getState, hasState } from '../state';

function resolveJobId(
  runtime: IAgentRuntime,
  options: Record<string, unknown> | undefined,
): string | null {
  const explicit = typeof options?.jobId === 'string' ? options.jobId : undefined;
  if (explicit) {
    return explicit;
  }
  const { activeJobs } = getState(runtime);
  for (const job of activeJobs.values()) {
    if (job.status === 'pending' || job.status === 'payment-required') {
      return job.id;
    }
  }
  return null;
}

export const cancelJobAction: Action = {
  name: 'ELISYM_CANCEL_JOB',
  similes: ['ABORT_JOB'],
  description:
    'Cancel a pending elisym job. On-chain refunds are not possible; this only stops waiting and marks the job cancelled locally.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    if (!hasState(runtime)) {
      return false;
    }
    for (const job of getState(runtime).activeJobs.values()) {
      if (job.status === 'pending' || job.status === 'payment-required') {
        return true;
      }
    }
    return false;
  },
  handler: async (runtime, _message, _state, options, callback): Promise<ActionResult> => {
    const jobId = resolveJobId(runtime, options);
    if (!jobId) {
      await callback?.({ text: 'No cancellable job found.', source: 'elisym' });
      return { success: false, data: { cancelled: false } };
    }
    const { activeJobs } = getState(runtime);
    const job = activeJobs.get(jobId);
    if (!job) {
      await callback?.({ text: `Job ${jobId.slice(0, 8)} not found.`, source: 'elisym' });
      return { success: false, data: { cancelled: false } };
    }
    const wasPaid = job.status === 'paid' || job.txSignature !== undefined;
    job.status = 'cancelled';
    job.lastUpdate = Date.now();
    job.cleanup?.();
    if (!wasPaid) {
      job.releaseReservation?.();
    }
    const note = wasPaid ? ' Payment already sent on-chain - no refund is possible.' : '';
    await callback?.({
      text: `Cancelled job ${jobId.slice(0, 8)}.${note}`,
      source: 'elisym',
    });
    return { success: true, data: { cancelled: true, jobId, refundable: false } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Cancel my pending elisym job' } },
      {
        name: '{{agent}}',
        content: { text: 'Cancelling...', actions: ['ELISYM_CANCEL_JOB'] },
      },
    ],
  ],
};
