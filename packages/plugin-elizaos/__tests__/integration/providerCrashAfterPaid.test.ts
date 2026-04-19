import { describe, expect, it } from 'vitest';
import { loadLatest, type JobLedgerEntry } from '../../src/lib/jobLedger';
import { FakeClient } from '../helpers/fakeClient';
import { createRecoveryHarness } from '../helpers/recoveryHarness';

const ID = 'job-paid';

function paidEntry(): JobLedgerEntry {
  return {
    jobEventId: ID,
    side: 'provider',
    state: 'paid',
    capability: 'summarization',
    priceLamports: '2000000',
    customerPubkey: 'customer-pk',
    txSignature: 'tx-sig',
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

describe('integration: provider crashed after marking paid', () => {
  it('re-executes via the model and publishes the result through the relay', async () => {
    const client = new FakeClient();
    const harness = await createRecoveryHarness({
      client,
      useModel: async () => 'summary text',
    });
    await harness.seed(paidEntry());

    await harness.sweep();

    expect(client.published).toEqual([{ jobEventId: ID, resultContent: 'summary text' }]);
    const ledger = await loadLatest(harness.runtime, 'provider');
    expect(ledger.get(ID)?.state).toBe('delivered');
    expect(ledger.get(ID)?.resultContent).toBe('summary text');
  });
});
