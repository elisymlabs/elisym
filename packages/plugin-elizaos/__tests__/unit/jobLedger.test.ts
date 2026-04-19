import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { describe, it, expect } from 'vitest';
import { JOBS_MEMORY_TABLE } from '../../src/constants';
import {
  findByJobId,
  loadLatest,
  pendingJobs,
  pruneOldEntries,
  recordTransition,
  type JobLedgerEntry,
} from '../../src/lib/jobLedger';

function makeRuntime(): IAgentRuntime & {
  _store: Map<string, Memory[]>;
  _nextId: number;
  deleteMemory: (id: string) => Promise<void>;
} {
  const store = new Map<string, Memory[]>();
  let nextId = 1;
  const agentId = '00000000-0000-0000-0000-000000000042' as UUID;
  const runtime = {
    agentId,
    _store: store,
    _nextId: nextId,
    async getMemories(params: { tableName: string }) {
      return [...(store.get(params.tableName) ?? [])];
    },
    async createMemory(memory: Memory, tableName: string) {
      const id = `mem-${nextId++}` as UUID;
      const list = store.get(tableName) ?? [];
      list.push({ ...memory, id });
      store.set(tableName, list);
      return id;
    },
    async deleteMemory(memoryId: string) {
      for (const [table, list] of store) {
        const filtered = list.filter((m) => m.id !== memoryId);
        if (filtered.length !== list.length) {
          store.set(table, filtered);
          return;
        }
      }
    },
  } as unknown as IAgentRuntime & {
    _store: Map<string, Memory[]>;
    _nextId: number;
    deleteMemory: (id: string) => Promise<void>;
  };
  return runtime;
}

function baseEntry(overrides: Partial<JobLedgerEntry> = {}): JobLedgerEntry {
  return {
    jobEventId: 'job-1',
    side: 'provider',
    state: 'waiting_payment',
    capability: 'summarization',
    priceLamports: '2000000',
    transitionAt: Date.now(),
    jobCreatedAt: Date.now(),
    version: 1,
    ...overrides,
  };
}

describe('jobLedger', () => {
  it('recordTransition round-trips through memory', async () => {
    const runtime = makeRuntime();
    await recordTransition(runtime, baseEntry());
    const latest = await loadLatest(runtime);
    expect(latest.size).toBe(1);
    expect(latest.get('job-1')?.state).toBe('waiting_payment');
  });

  it('loadLatest picks the newest transition per jobEventId', async () => {
    const runtime = makeRuntime();
    await recordTransition(runtime, baseEntry({ state: 'waiting_payment', transitionAt: 100 }));
    await recordTransition(
      runtime,
      baseEntry({ state: 'paid', txSignature: 'sig1', transitionAt: 200 }),
    );
    await recordTransition(
      runtime,
      baseEntry({ state: 'executed', resultContent: 'out', transitionAt: 300 }),
    );
    const latest = await loadLatest(runtime);
    expect(latest.get('job-1')?.state).toBe('executed');
    expect(latest.get('job-1')?.resultContent).toBe('out');
  });

  it('loadLatest filters by side', async () => {
    const runtime = makeRuntime();
    await recordTransition(runtime, baseEntry({ jobEventId: 'a', side: 'provider' }));
    await recordTransition(runtime, baseEntry({ jobEventId: 'b', side: 'customer' }));
    const providerOnly = await loadLatest(runtime, 'provider');
    expect(providerOnly.size).toBe(1);
    expect(providerOnly.get('a')).toBeDefined();
    expect(providerOnly.get('b')).toBeUndefined();
  });

  it('pendingJobs excludes terminal states', async () => {
    const runtime = makeRuntime();
    await recordTransition(
      runtime,
      baseEntry({ jobEventId: 'p-paid', state: 'paid', transitionAt: 10 }),
    );
    await recordTransition(
      runtime,
      baseEntry({ jobEventId: 'p-delivered', state: 'delivered', transitionAt: 20 }),
    );
    await recordTransition(
      runtime,
      baseEntry({ jobEventId: 'p-failed', state: 'failed', transitionAt: 30 }),
    );
    await recordTransition(
      runtime,
      baseEntry({ jobEventId: 'p-executed', state: 'executed', transitionAt: 40 }),
    );
    const pending = await pendingJobs(runtime, 'provider');
    const ids = pending.map((e) => e.jobEventId).sort();
    expect(ids).toEqual(['p-executed', 'p-paid']);
  });

  it('pendingJobs sorted by jobCreatedAt ascending', async () => {
    const runtime = makeRuntime();
    await recordTransition(
      runtime,
      baseEntry({ jobEventId: 'new', state: 'paid', jobCreatedAt: 200 }),
    );
    await recordTransition(
      runtime,
      baseEntry({ jobEventId: 'old', state: 'paid', jobCreatedAt: 100 }),
    );
    const pending = await pendingJobs(runtime, 'provider');
    expect(pending.map((e) => e.jobEventId)).toEqual(['old', 'new']);
  });

  it('findByJobId returns the current state', async () => {
    const runtime = makeRuntime();
    await recordTransition(runtime, baseEntry({ state: 'waiting_payment', transitionAt: 10 }));
    await recordTransition(runtime, baseEntry({ state: 'paid', transitionAt: 20 }));
    const entry = await findByJobId(runtime, 'job-1');
    expect(entry?.state).toBe('paid');
  });

  it('pruneOldEntries removes terminal jobs older than retention', async () => {
    const runtime = makeRuntime();
    const ancient = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const recent = Date.now() - 5 * 60 * 1000;
    const writeRow = async (
      jobEventId: string,
      state: JobLedgerEntry['state'],
      createdAt: number,
    ) => {
      const entry: JobLedgerEntry = baseEntry({ jobEventId, state, transitionAt: createdAt });
      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: runtime.agentId,
          content: {
            text: '[job-ledger]',
            source: 'elisym-ledger',
            elisym_ledger: true,
            entry,
          },
          createdAt,
        },
        JOBS_MEMORY_TABLE,
        false,
      );
    };
    await writeRow('old-terminal', 'delivered', ancient);
    await writeRow('recent-terminal', 'delivered', recent);
    await writeRow('old-stuck', 'paid', ancient);

    const deleted = await pruneOldEntries(runtime);
    expect(deleted).toBe(1);
    const remaining = await loadLatest(runtime);
    expect(remaining.has('old-terminal')).toBe(false);
    expect(remaining.has('recent-terminal')).toBe(true);
    // Stuck non-terminal jobs are never auto-pruned.
    expect(remaining.has('old-stuck')).toBe(true);
  });

  it('loadLatest skips non-ledger memory rows in the same table', async () => {
    const runtime = makeRuntime();
    // Inject a non-ledger memory in the same table (e.g., legacy / corrupted row).
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: 'noise', source: 'something-else' },
        createdAt: Date.now(),
      },
      JOBS_MEMORY_TABLE,
      false,
    );
    await recordTransition(runtime, baseEntry());
    const latest = await loadLatest(runtime);
    expect(latest.size).toBe(1);
  });
});
