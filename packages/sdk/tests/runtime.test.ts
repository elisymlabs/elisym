import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryJobLedgerAdapter,
  createRecoveryLoop,
  findByJobId,
  JOB_LEDGER_VERSION,
  pendingJobs,
  TERMINAL_STATES,
  type JobLedgerEntry,
  type JobLedgerWriteInput,
} from '../src/runtime';

function baseWrite(overrides: Partial<JobLedgerWriteInput> = {}): JobLedgerWriteInput {
  return {
    jobEventId: 'job-1',
    side: 'provider',
    state: 'waiting_payment',
    capability: 'summarization',
    priceLamports: '1000000',
    jobCreatedAt: Date.now() - 30_000,
    ...overrides,
  };
}

describe('memory JobLedger adapter', () => {
  it('stamps transitionAt and version on write', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    await adapter.write(baseWrite());
    const latest = await adapter.loadLatest();
    const entry = latest.get('job-1');
    expect(entry?.version).toBe(JOB_LEDGER_VERSION);
    expect(typeof entry?.transitionAt).toBe('number');
  });

  it('loadLatest returns the most recent write per jobEventId', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    await adapter.write(baseWrite({ state: 'waiting_payment' }));
    await adapter.write(baseWrite({ state: 'paid', txSignature: 'sig-1' }));
    await adapter.write(baseWrite({ state: 'executed', resultContent: 'ok' }));
    const latest = await adapter.loadLatest('provider');
    expect(latest.get('job-1')?.state).toBe('executed');
    expect(latest.get('job-1')?.resultContent).toBe('ok');
  });

  it('loadLatest filters by side', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    await adapter.write(baseWrite({ jobEventId: 'p-job', side: 'provider' }));
    await adapter.write(baseWrite({ jobEventId: 'c-job', side: 'customer', state: 'submitted' }));
    const providers = await adapter.loadLatest('provider');
    const customers = await adapter.loadLatest('customer');
    expect([...providers.keys()]).toEqual(['p-job']);
    expect([...customers.keys()]).toEqual(['c-job']);
  });

  it('pendingJobs returns non-terminal entries oldest-first', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    const now = Date.now();
    await adapter.write(
      baseWrite({ jobEventId: 'a', state: 'waiting_payment', jobCreatedAt: now - 10_000 }),
    );
    await adapter.write(baseWrite({ jobEventId: 'b', state: 'paid', jobCreatedAt: now - 20_000 }));
    await adapter.write(
      baseWrite({ jobEventId: 'c', state: 'delivered', jobCreatedAt: now - 5_000 }),
    );
    const pending = await pendingJobs(adapter, 'provider');
    expect(pending.map((entry) => entry.jobEventId)).toEqual(['b', 'a']);
  });

  it('findByJobId returns undefined for unknown ids', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    expect(await findByJobId(adapter, 'missing')).toBeUndefined();
  });

  it('pruneOldEntries drops only terminal entries past retentionMs', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await adapter.write(baseWrite({ jobEventId: 'old-terminal', state: 'delivered' }));
      await adapter.write(baseWrite({ jobEventId: 'old-stuck', state: 'paid' }));

      vi.setSystemTime(60_000);
      await adapter.write(baseWrite({ jobEventId: 'fresh-terminal', state: 'delivered' }));

      vi.setSystemTime(200_000);
      const deleted = await adapter.pruneOldEntries(100_000);
      // cutoff = 200_000 - 100_000 = 100_000. 'old-terminal' (terminal at 0)
      // is past cutoff; 'old-stuck' (non-terminal) is retained; 'fresh-terminal'
      // transitioned at 60_000 which is before cutoff too, so both terminals drop.
      expect(deleted).toBe(2);

      const latest = await adapter.loadLatest();
      expect(latest.has('old-terminal')).toBe(false);
      expect(latest.has('old-stuck')).toBe(true);
      expect(latest.has('fresh-terminal')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TERMINAL_STATES matches the expected set', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      ['cancelled', 'delivered', 'failed', 'result_received'].sort(),
    );
  });

  it('clear() empties the append log', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    await adapter.write(baseWrite());
    adapter.clear();
    expect((await adapter.loadLatest()).size).toBe(0);
  });
});

describe('createRecoveryLoop', () => {
  it('invokes onProviderPending for non-terminal provider entries', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    const seen: string[] = [];
    await adapter.write(baseWrite({ jobEventId: 'p1', state: 'paid' }));
    await adapter.write(baseWrite({ jobEventId: 'p2', state: 'executed' }));
    await adapter.write(baseWrite({ jobEventId: 'p3', state: 'delivered' }));

    const loop = createRecoveryLoop({
      adapter,
      intervalMs: 60_000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      concurrency: 2,
      async onProviderPending(entry: JobLedgerEntry) {
        seen.push(entry.jobEventId);
      },
    });
    await loop.sweepOnce();
    expect(seen.sort()).toEqual(['p1', 'p2']);
  });

  it('routes customer entries through onCustomerPending only', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    const providerSeen: string[] = [];
    const customerSeen: string[] = [];
    await adapter.write(baseWrite({ jobEventId: 'p', side: 'provider', state: 'paid' }));
    await adapter.write(baseWrite({ jobEventId: 'c', side: 'customer', state: 'submitted' }));

    const loop = createRecoveryLoop({
      adapter,
      intervalMs: 60_000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      concurrency: 1,
      async onProviderPending(entry) {
        providerSeen.push(entry.jobEventId);
      },
      async onCustomerPending(entry) {
        customerSeen.push(entry.jobEventId);
      },
    });
    await loop.sweepOnce();
    expect(providerSeen).toEqual(['p']);
    expect(customerSeen).toEqual(['c']);
  });

  it('sweeps prune + handler exactly once even if ticks overlap', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    await adapter.write(baseWrite({ jobEventId: 'slow', state: 'paid' }));
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const loop = createRecoveryLoop({
      adapter,
      intervalMs: 60_000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      concurrency: 4,
      async onProviderPending() {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
      },
    });
    const first = loop.sweepOnce();
    const second = loop.sweepOnce();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
  });

  it('caps concurrent workers to the configured value', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    for (let index = 0; index < 6; index++) {
      await adapter.write(baseWrite({ jobEventId: `j${index}`, state: 'paid' }));
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const loop = createRecoveryLoop({
      adapter,
      intervalMs: 60_000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      concurrency: 2,
      async onProviderPending() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    });
    await loop.sweepOnce();
    expect(maxInFlight).toBe(2);
  });

  it('logs handler errors without stopping the batch', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    await adapter.write(baseWrite({ jobEventId: 'good', state: 'paid' }));
    await adapter.write(baseWrite({ jobEventId: 'bad', state: 'paid' }));
    const warnings: Array<Record<string, unknown>> = [];
    const loop = createRecoveryLoop({
      adapter,
      intervalMs: 60_000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      concurrency: 1,
      logger: {
        warn(obj) {
          warnings.push(obj);
        },
      },
      async onProviderPending(entry) {
        if (entry.jobEventId === 'bad') {
          throw new Error('boom');
        }
      },
    });
    await loop.sweepOnce();
    expect(warnings.some((entry) => entry.jobEventId === 'bad')).toBe(true);
  });

  it('rejects non-positive options', () => {
    const adapter = createMemoryJobLedgerAdapter();
    expect(() =>
      createRecoveryLoop({
        adapter,
        intervalMs: 0,
        retentionMs: 1,
        concurrency: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createRecoveryLoop({
        adapter,
        intervalMs: 1,
        retentionMs: 1,
        concurrency: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createRecoveryLoop({
        adapter,
        intervalMs: 1,
        retentionMs: 0,
        concurrency: 1,
      }),
    ).toThrow(RangeError);
  });

  it('start/stop controls the periodic timer', async () => {
    const adapter = createMemoryJobLedgerAdapter();
    const loop = createRecoveryLoop({
      adapter,
      intervalMs: 100,
      retentionMs: 30_000,
      concurrency: 1,
    });
    loop.start();
    loop.stop();
    // Calling stop twice is a no-op.
    loop.stop();
  });
});
