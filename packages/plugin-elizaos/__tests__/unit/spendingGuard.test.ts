import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { describe, it, expect } from 'vitest';
import { HOUR_MS, SPEND_MEMORY_TABLE } from '../../src/constants';
import {
  createSpendingBucket,
  assertCanSpend,
  requiresApproval,
  recordSpend,
  hourlyTotal,
  loadSpendingHistory,
  persistSpend,
  SpendingLimitError,
} from '../../src/lib/spendingGuard';

function makeRuntime(): IAgentRuntime & { _store: Map<string, Memory[]> } {
  const store = new Map<string, Memory[]>();
  let nextId = 1;
  return {
    agentId: '00000000-0000-0000-0000-000000000001' as UUID,
    _store: store,
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
  } as unknown as IAgentRuntime & { _store: Map<string, Memory[]> };
}

function bucket() {
  return createSpendingBucket({
    maxSpendPerJobLamports: 20_000_000n,
    maxSpendPerHourLamports: 50_000_000n,
    requireApprovalAboveLamports: 5_000_000n,
  });
}

describe('spendingGuard', () => {
  it('rejects non-positive amounts', () => {
    expect(() => assertCanSpend(bucket(), 0n)).toThrow(SpendingLimitError);
    expect(() => assertCanSpend(bucket(), -1n)).toThrow(SpendingLimitError);
  });

  it('rejects amounts above per-job cap', () => {
    expect(() => assertCanSpend(bucket(), 20_000_001n)).toThrow(/per-job cap/);
  });

  it('accepts amounts within per-job cap', () => {
    expect(() => assertCanSpend(bucket(), 20_000_000n)).not.toThrow();
  });

  it('tracks hourly total and rejects overflow', () => {
    const b = bucket();
    recordSpend(b, 15_000_000n);
    recordSpend(b, 15_000_000n);
    recordSpend(b, 15_000_000n);
    expect(hourlyTotal(b)).toBe(45_000_000n);
    expect(() => assertCanSpend(b, 10_000_000n)).toThrow(/hourly cap/);
  });

  it('prunes events older than one hour', () => {
    const b = bucket();
    const stale = Date.now() - HOUR_MS - 1;
    recordSpend(b, 45_000_000n, stale);
    expect(hourlyTotal(b)).toBe(0n);
    expect(() => assertCanSpend(b, 20_000_000n)).not.toThrow();
  });

  it('flags amounts above approval threshold', () => {
    const b = bucket();
    expect(requiresApproval(b, 5_000_000n)).toBe(false);
    expect(requiresApproval(b, 5_000_001n)).toBe(true);
  });

  it('persistSpend then loadSpendingHistory round-trips', async () => {
    const runtime = makeRuntime();
    await persistSpend(runtime, 2_000_000n, 1_700_000_000_000);
    await persistSpend(runtime, 3_000_000n, Date.now());
    const history = await loadSpendingHistory(runtime);
    // Older-than-1h entry is dropped, recent one kept.
    expect(history.length).toBe(1);
    expect(history[0]?.lamports).toBe(3_000_000n);
  });

  it('loadSpendingHistory seeds bucket so hourly cap survives restart', async () => {
    const runtime = makeRuntime();
    await persistSpend(runtime, 40_000_000n);
    const history = await loadSpendingHistory(runtime);
    const b = createSpendingBucket(
      {
        maxSpendPerJobLamports: 20_000_000n,
        maxSpendPerHourLamports: 50_000_000n,
        requireApprovalAboveLamports: 5_000_000n,
      },
      history,
    );
    expect(hourlyTotal(b)).toBe(40_000_000n);
    expect(() => assertCanSpend(b, 20_000_000n)).toThrow(/hourly cap/);
  });

  it('loadSpendingHistory skips unrelated memory rows in the same table', async () => {
    const runtime = makeRuntime();
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: 'noise', source: 'other' },
        createdAt: Date.now(),
      },
      SPEND_MEMORY_TABLE,
      false,
    );
    await persistSpend(runtime, 1_000_000n);
    const history = await loadSpendingHistory(runtime);
    expect(history.length).toBe(1);
  });
});
