import { describe, expect, it } from 'vitest';
import { loadLatest, type JobLedgerEntry } from '../../src/lib/jobLedger';
import { FakeClient } from '../helpers/fakeClient';
import { createRecoveryHarness } from '../helpers/recoveryHarness';

const ID = 'job-submitted';

function staleSubmittedEntry(): JobLedgerEntry {
  return {
    jobEventId: ID,
    side: 'customer',
    state: 'submitted',
    capability: 'summarization',
    priceLamports: '1000000',
    providerPubkey: 'provider-pk',
    transitionAt: Date.now() - 5 * 60 * 1000,
    jobCreatedAt: Date.now() - 5 * 60 * 1000,
    version: 1,
  };
}

describe('integration: customer crashed after submitting the job', () => {
  it('marks failed once the pre-payment grace window expires', async () => {
    const client = new FakeClient();
    const harness = await createRecoveryHarness({ client });
    await harness.seed(staleSubmittedEntry());

    await harness.sweep();

    const ledger = await loadLatest(harness.runtime, 'customer');
    expect(ledger.get(ID)?.state).toBe('failed');
    expect(ledger.get(ID)?.error).toMatch(/timed out before payment/);
    expect(client.queries).toHaveLength(0);
  });

  it('leaves a fresh submitted job alone (still inside grace window)', async () => {
    const client = new FakeClient();
    const harness = await createRecoveryHarness({ client });
    const fresh = { ...staleSubmittedEntry(), jobCreatedAt: Date.now() - 5_000 };
    await harness.seed(fresh);

    await harness.sweep();

    const ledger = await loadLatest(harness.runtime, 'customer');
    expect(ledger.get(ID)?.state).toBe('submitted');
  });
});
