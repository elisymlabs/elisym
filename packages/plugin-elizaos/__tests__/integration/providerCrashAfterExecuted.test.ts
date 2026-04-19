import { describe, expect, it } from 'vitest';
import { loadLatest, type JobLedgerEntry } from '../../src/lib/jobLedger';
import { FakeClient } from '../helpers/fakeClient';
import { createRecoveryHarness } from '../helpers/recoveryHarness';

const ID = 'job-executed';

function executedEntry(): JobLedgerEntry {
  return {
    jobEventId: ID,
    side: 'provider',
    state: 'executed',
    capability: 'summarization',
    priceLamports: '2000000',
    customerPubkey: 'customer-pk',
    txSignature: 'tx-sig',
    resultContent: 'cached summary',
    rawEventJson: JSON.stringify({
      id: ID,
      kind: 5100,
      content: 'please summarize',
      tags: [['t', 'summarization']],
      pubkey: 'customer-pk',
      created_at: Math.floor(Date.now() / 1000),
      sig: '00'.repeat(64),
    }),
    transitionAt: Date.now() - 1000,
    jobCreatedAt: Date.now() - 60_000,
    version: 1,
  };
}

describe('integration: provider crashed after caching the result', () => {
  it('skips re-execute and republishes the cached result', async () => {
    let modelInvocations = 0;
    const client = new FakeClient();
    const harness = await createRecoveryHarness({
      client,
      useModel: async () => {
        modelInvocations += 1;
        return 'should-not-be-called';
      },
    });
    await harness.seed(executedEntry());

    await harness.sweep();

    expect(modelInvocations).toBe(0);
    expect(client.published).toEqual([{ jobEventId: ID, resultContent: 'cached summary' }]);
    const ledger = await loadLatest(harness.runtime, 'provider');
    expect(ledger.get(ID)?.state).toBe('delivered');
  });

  it('records the relay error without losing the cached result on transient failure', async () => {
    const client = new FakeClient({ failNextSubmit: new Error('relay outage') });
    const harness = await createRecoveryHarness({ client });
    await harness.seed(executedEntry());

    await harness.sweep();

    const ledger = await loadLatest(harness.runtime, 'provider');
    const current = ledger.get(ID);
    expect(current?.state).toBe('executed');
    expect(current?.resultContent).toBe('cached summary');
    expect(current?.error).toContain('relay outage');
    expect(current?.retryCount ?? 0).toBe(1);
  });
});
