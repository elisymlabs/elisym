import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WALLET_MEMORY_TABLE } from '../../src/constants';
import { createSigner, isSignerKind, SIGNER_KINDS } from '../../src/lib/signers';
import { generateSolanaSecretBase58 } from '../../src/lib/solana';

function makeRuntime(): IAgentRuntime {
  const store = new Map<string, Memory[]>();
  const agentId = '00000000-0000-0000-0000-000000000001' as UUID;
  return {
    agentId,
    getSetting: () => undefined,
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

const KMS_ENV = ['ELISYM_KMS_PROVIDER', 'ELISYM_KMS_KEY_ID'] as const;

afterEach(() => {
  for (const key of KMS_ENV) {
    delete process.env[key];
  }
});

describe('signer factory', () => {
  it('exposes the three known kinds', () => {
    expect(SIGNER_KINDS).toEqual(['local', 'kms', 'external']);
  });

  it('isSignerKind narrows on known values', () => {
    expect(isSignerKind('local')).toBe(true);
    expect(isSignerKind('kms')).toBe(true);
    expect(isSignerKind('external')).toBe(true);
    expect(isSignerKind('hardware')).toBe(false);
  });

  it('local kind generates and persists a signer when no config or memory present', async () => {
    const runtime = makeRuntime();
    const handle = await createSigner('local', { runtime });
    expect(handle.kind).toBe('local');
    expect(handle.source).toBe('generated');
    expect(typeof handle.signer.address).toBe('string');
    const persisted = await runtime.getMemories({
      tableName: WALLET_MEMORY_TABLE,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      count: 100,
    });
    expect(persisted).toHaveLength(1);
  });

  it('local kind reuses fromConfig when supplied', async () => {
    const runtime = makeRuntime();
    const fromConfig = await generateSolanaSecretBase58();
    const handle = await createSigner('local', { runtime, fromConfig });
    expect(handle.source).toBe('config');
  });

  it('local kind reuses persisted secret on second start', async () => {
    const runtime = makeRuntime();
    const first = await createSigner('local', { runtime });
    expect(first.source).toBe('generated');
    const second = await createSigner('local', { runtime });
    expect(second.source).toBe('persisted');
    expect(second.signer.address).toBe(first.signer.address);
  });

  it('kms kind rejects when required env is missing, naming the gaps', async () => {
    const runtime = makeRuntime();
    await expect(createSigner('kms', { runtime })).rejects.toThrow(
      /ELISYM_KMS_PROVIDER, ELISYM_KMS_KEY_ID/,
    );
  });

  it('kms kind rejects with not-implemented even when env is provided (no bundled adapter)', async () => {
    process.env.ELISYM_KMS_PROVIDER = 'aws';
    process.env.ELISYM_KMS_KEY_ID = 'arn:aws:kms:us-east-1:000000000000:key/abc';
    const runtime = makeRuntime();
    await expect(createSigner('kms', { runtime })).rejects.toThrow(/no concrete KMS adapter/);
  });

  it('external kind always rejects with integration pointer', async () => {
    const runtime = makeRuntime();
    await expect(createSigner('external', { runtime })).rejects.toThrow(/custom adapter/);
  });
});
