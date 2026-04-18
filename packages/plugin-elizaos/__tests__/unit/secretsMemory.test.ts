import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import bs58 from 'bs58';
import { describe, it, expect } from 'vitest';
import { IDENTITY_MEMORY_TABLE, WALLET_MEMORY_TABLE } from '../../src/constants';
import {
  loadPersistedNostrSecret,
  loadPersistedSolanaSecret,
  persistNostrSecret,
  persistSolanaSecret,
} from '../../src/lib/secretsMemory';
import { generateSolanaSecretBase58 } from '../../src/lib/solana';

function makeRuntime(): IAgentRuntime {
  const store = new Map<string, Memory[]>();
  const agentId = '00000000-0000-0000-0000-000000000001' as UUID;
  return {
    agentId,
    async getMemories(params: { tableName: string }) {
      return [...(store.get(params.tableName) ?? [])];
    },
    async createMemory(memory: Memory, tableName: string) {
      const list = store.get(tableName) ?? [];
      list.push(memory);
      store.set(tableName, list);
      return 'id' as UUID;
    },
  } as unknown as IAgentRuntime;
}

describe('secretsMemory', () => {
  it('round-trips a Nostr secret through agent memory', async () => {
    const runtime = makeRuntime();
    expect(await loadPersistedNostrSecret(runtime)).toBeUndefined();

    const hex = 'a'.repeat(64);
    await persistNostrSecret(runtime, hex);
    expect(await loadPersistedNostrSecret(runtime)).toBe(hex);
  });

  it('round-trips a Solana secret through agent memory', async () => {
    const runtime = makeRuntime();
    const base58 = bs58.encode(new Uint8Array(64).fill(3));
    await persistSolanaSecret(runtime, base58);
    expect(await loadPersistedSolanaSecret(runtime)).toBe(base58);
  });

  it('uses separate tables for Nostr and Solana', async () => {
    const runtime = makeRuntime();
    await persistNostrSecret(runtime, 'b'.repeat(64));
    const solanaSecret = bs58.encode(new Uint8Array(64).fill(7));
    await persistSolanaSecret(runtime, solanaSecret);

    const mixedRuntime = runtime as unknown as {
      getMemories: (params: { tableName: string }) => Promise<Memory[]>;
    };
    expect(await mixedRuntime.getMemories({ tableName: IDENTITY_MEMORY_TABLE })).toHaveLength(1);
    expect(await mixedRuntime.getMemories({ tableName: WALLET_MEMORY_TABLE })).toHaveLength(1);
  });

  it('prefers the oldest entry if duplicates were written', async () => {
    const runtime = makeRuntime();
    await persistSolanaSecret(runtime, bs58.encode(new Uint8Array(64).fill(1)));
    // Manually insert a younger duplicate.
    await runtime.createMemory(
      {
        entityId: runtime.agentId!,
        agentId: runtime.agentId!,
        roomId: runtime.agentId!,
        content: { text: '[redacted]', secret: bs58.encode(new Uint8Array(64).fill(2)) },
        createdAt: Date.now() + 10_000,
      },
      WALLET_MEMORY_TABLE,
      true,
    );
    const loaded = await loadPersistedSolanaSecret(runtime);
    expect(loaded).toBe(bs58.encode(new Uint8Array(64).fill(1)));
  });

  it('generates a valid 64-byte Solana secret key', async () => {
    const base58 = await generateSolanaSecretBase58();
    const bytes = bs58.decode(base58);
    expect(bytes.length).toBe(64);
  });
});
