import { describe, expect, it } from 'vitest';
import { loadLatest, type JobLedgerEntry } from '../../src/lib/jobLedger';
import { FakeClient } from '../helpers/fakeClient';
import { createRecoveryHarness } from '../helpers/recoveryHarness';

const ID = 'job-paid-out';

function paymentSentEntry(): JobLedgerEntry {
  return {
    jobEventId: ID,
    side: 'customer',
    state: 'payment_sent',
    capability: 'summarization',
    priceLamports: '1000000',
    providerPubkey: 'provider-pk',
    txSignature: 'cust-sig',
    transitionAt: Date.now() - 1000,
    jobCreatedAt: Date.now() - 30_000,
    version: 1,
  };
}

describe('integration: customer crashed after sending payment', () => {
  it('picks up the result event when the relay returns it', async () => {
    const client = new FakeClient({
      results: new Map([
        [ID, { content: 'the answer', senderPubkey: 'provider-pk', decryptionFailed: false }],
      ]),
    });
    const harness = await createRecoveryHarness({ client });
    await harness.seed(paymentSentEntry());

    await harness.sweep();

    expect(client.queries).toEqual([{ jobIds: [ID], provider: 'provider-pk' }]);
    const ledger = await loadLatest(harness.runtime, 'customer');
    expect(ledger.get(ID)?.state).toBe('result_received');
    expect(ledger.get(ID)?.resultContent).toBe('the answer');
  });

  it('marks failed if no result has appeared within the deadline', async () => {
    const client = new FakeClient();
    const harness = await createRecoveryHarness({ client });
    const stale = { ...paymentSentEntry(), jobCreatedAt: Date.now() - 11 * 60 * 1000 };
    await harness.seed(stale);

    await harness.sweep();

    const ledger = await loadLatest(harness.runtime, 'customer');
    expect(ledger.get(ID)?.state).toBe('failed');
    expect(ledger.get(ID)?.error).toMatch(/Result not observed/);
  });

  it('keeps polling when the result is still missing inside the deadline', async () => {
    const client = new FakeClient();
    const harness = await createRecoveryHarness({ client });
    await harness.seed(paymentSentEntry());

    await harness.sweep();

    const ledger = await loadLatest(harness.runtime, 'customer');
    expect(ledger.get(ID)?.state).toBe('payment_sent');
  });
});
