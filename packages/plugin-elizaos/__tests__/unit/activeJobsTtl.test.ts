import { describe, expect, it } from 'vitest';
import { ACTIVE_JOBS_TTL_MS } from '../../src/constants';
import { jobCompletionEvaluator } from '../../src/evaluators/jobCompletionEvaluator';
import { getState } from '../../src/state';
import type { ActiveJob } from '../../src/types';
import { bootState, makeStubRuntime } from '../helpers/runtime';

function pendingJob(id: string, lastUpdate: number): ActiveJob {
  return {
    id,
    status: 'pending',
    providerPubkey: 'p',
    lamports: 1_000_000n,
    capability: 'summarization',
    createdAt: lastUpdate,
    lastUpdate,
  };
}

describe('jobCompletionEvaluator: activeJobs TTL', () => {
  it('drops a stuck pending job once TTL has passed', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const state = getState(runtime);
    const stale = pendingJob('stale', Date.now() - ACTIVE_JOBS_TTL_MS - 1_000);
    const fresh = pendingJob('fresh', Date.now());
    state.activeJobs.set(stale.id, stale);
    state.activeJobs.set(fresh.id, fresh);

    const ok = await jobCompletionEvaluator.validate(runtime);
    expect(ok).toBe(true);
    await jobCompletionEvaluator.handler(runtime);
    expect(state.activeJobs.has('stale')).toBe(false);
    expect(state.activeJobs.has('fresh')).toBe(true);
  });

  it('still finalises terminal jobs even when no stuck entries exist', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const state = getState(runtime);
    const done: ActiveJob = { ...pendingJob('done', Date.now()), status: 'success' };
    state.activeJobs.set(done.id, done);
    await jobCompletionEvaluator.handler(runtime);
    expect(state.activeJobs.has('done')).toBe(false);
  });

  it('validate returns false when nothing is terminal nor stuck', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const state = getState(runtime);
    state.activeJobs.set('fresh', pendingJob('fresh', Date.now()));
    expect(await jobCompletionEvaluator.validate(runtime)).toBe(false);
  });
});
