import { describe, expect, it } from 'vitest';
import { RECOVERY_CONCURRENCY } from '../../src/constants';
import { loadLatest, type JobLedgerEntry } from '../../src/lib/jobLedger';
import { FakeClient } from '../helpers/fakeClient';
import { createRecoveryHarness } from '../helpers/recoveryHarness';

function executedEntry(id: string): JobLedgerEntry {
  return {
    jobEventId: id,
    side: 'provider',
    state: 'executed',
    capability: 'summarization',
    priceLamports: '2000000',
    customerPubkey: 'customer-pk',
    txSignature: 'tx',
    resultContent: `result-${id}`,
    rawEventJson: JSON.stringify({
      id,
      kind: 5100,
      content: 'task',
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

describe('integration: recovery concurrency ceiling', () => {
  it('processes pending jobs at most RECOVERY_CONCURRENCY at a time', async () => {
    const inflight = { current: 0, peak: 0 };
    const release: Array<() => void> = [];
    const client = new FakeClient();
    // Wrap submit so we can hold each call open until we release it,
    // letting the test observe the in-flight ceiling directly.
    const originalSubmit = client.marketplace.submitJobResultWithRetry.bind(client.marketplace);
    client.marketplace.submitJobResultWithRetry = async (
      identity: unknown,
      event: { id: string },
      content: string,
    ): Promise<string> => {
      inflight.current += 1;
      inflight.peak = Math.max(inflight.peak, inflight.current);
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      try {
        return await originalSubmit(identity, event, content);
      } finally {
        inflight.current -= 1;
      }
    };

    const harness = await createRecoveryHarness({ client });
    const TOTAL = RECOVERY_CONCURRENCY * 3;
    for (let i = 0; i < TOTAL; i++) {
      await harness.seed(executedEntry(`job-${i}`));
    }

    const sweepPromise = harness.sweep();

    // Wait until the limiter saturates (all RECOVERY_CONCURRENCY workers
    // are blocked on submit), then drain incrementally so the test does
    // not depend on event-loop ordering.
    while (release.length < RECOVERY_CONCURRENCY) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(inflight.current).toBeLessThanOrEqual(RECOVERY_CONCURRENCY);

    while (release.length > 0) {
      release.shift()?.();
      // give the loop a microtask tick so the next handler can pick up
      await new Promise((resolve) => setImmediate(resolve));
    }
    await sweepPromise;

    expect(inflight.peak).toBe(RECOVERY_CONCURRENCY);
    expect(client.published).toHaveLength(TOTAL);
    const ledger = await loadLatest(harness.runtime, 'provider');
    for (let i = 0; i < TOTAL; i++) {
      expect(ledger.get(`job-${i}`)?.state).toBe('delivered');
    }
  });
});
