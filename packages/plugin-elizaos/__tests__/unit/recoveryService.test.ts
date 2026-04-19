import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { describe, expect, it } from 'vitest';
import type { ElisymConfig } from '../../src/environment';
import { loadLatest, recordTransition, type JobLedgerEntry } from '../../src/lib/jobLedger';
import { SkillRegistry } from '../../src/skills';
import type { LlmClient, Skill } from '../../src/skills';
import { getState, initState } from '../../src/state';

function stubConfig(): ElisymConfig {
  return {
    network: 'devnet',
    mode: 'both',
    maxSpendPerJobLamports: 10_000_000n,
    maxSpendPerHourLamports: 100_000_000n,
    requireApprovalAboveLamports: 5_000_000n,
  } as unknown as ElisymConfig;
}

// Force the service module to be loadable in a pure unit test - we stub
// ElisymService / WalletService via runtime.getServiceLoadPromise, skip
// actual Nostr / Solana calls. This exercises branching logic:
// retry budget, waiting_payment grace, paid re-delivery, customer result
// pickup.

interface RuntimeMocks {
  actions: IAgentRuntime['actions'];
  useModel: (type: string, params: { prompt: string }) => Promise<string>;
  getServiceLoadPromise: (type: string) => Promise<unknown>;
}

function makeRuntime(mocks: Partial<RuntimeMocks> = {}): IAgentRuntime & {
  _store: Map<string, Memory[]>;
} {
  const store = new Map<string, Memory[]>();
  let nextId = 1;
  const agentId = '00000000-0000-0000-0000-000000000042' as UUID;
  return {
    agentId,
    character: { name: 'Recoverer', bio: 'test', system: 'test system' },
    actions: mocks.actions ?? [],
    _store: store,
    async useModel(_type: string, params: { prompt: string }) {
      return mocks.useModel
        ? mocks.useModel(_type, params)
        : `processed: ${params.prompt.slice(-20)}`;
    },
    async getServiceLoadPromise(type: string) {
      return mocks.getServiceLoadPromise ? mocks.getServiceLoadPromise(type) : undefined;
    },
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

// We import RecoveryService lazily because it imports ElizaOS types at
// module level; the stubbed runtime is enough for these tests.
async function loadService() {
  const mod = await import('../../src/services/RecoveryService');
  return mod.RecoveryService;
}

function providerEntry(overrides: Partial<JobLedgerEntry> = {}): JobLedgerEntry {
  return {
    jobEventId: 'job-p',
    side: 'provider',
    state: 'paid',
    capability: 'summarization',
    priceLamports: '2000000',
    rawEventJson: JSON.stringify({
      id: 'job-p',
      kind: 5100,
      content: 'please summarize this',
      tags: [
        ['t', 'elisym'],
        ['t', 'summarization'],
      ],
      pubkey: 'customer-pubkey',
      created_at: Math.floor(Date.now() / 1000),
      sig: '00'.repeat(64),
    }),
    txSignature: 'sig-abc',
    transitionAt: Date.now() - 1000,
    jobCreatedAt: Date.now() - 60_000,
    version: 1,
    ...overrides,
  };
}

describe('RecoveryService', () => {
  it('retry budget exhausts: moves provider job to failed', async () => {
    const runtime = makeRuntime();
    const entry = providerEntry({ retryCount: 99 });
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverProviderJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
      wallet?: unknown;
    })(runtime);
    service.elisym = {} as unknown;
    service.wallet = {} as unknown;

    await service.recoverProviderJob(entry);

    const latest = await loadLatest(runtime, 'provider');
    const current = latest.get('job-p');
    expect(current?.state).toBe('failed');
    expect(current?.error).toContain('retry budget exhausted');
  });

  it('paid entry with cached resultContent goes straight to delivery', async () => {
    const runtime = makeRuntime();
    const submitted: string[] = [];
    const mockClient = {
      marketplace: {
        async submitJobResultWithRetry(_id: unknown, event: { id: string }, content: string) {
          submitted.push(`${event.id}|${content}`);
          return 'result-event-id';
        },
      },
    };
    const entry = providerEntry({ state: 'executed', resultContent: 'cached result' });
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverProviderJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
      wallet?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => mockClient,
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;
    service.wallet = {} as unknown;

    await service.recoverProviderJob(entry);

    expect(submitted).toEqual(['job-p|cached result']);
    const latest = await loadLatest(runtime, 'provider');
    expect(latest.get('job-p')?.state).toBe('delivered');
  });

  it('customer payment_sent picks up result from relay and marks received', async () => {
    const runtime = makeRuntime();
    const queried: string[][] = [];
    const mockClient = {
      marketplace: {
        async queryJobResults(_identity: unknown, requestIds: string[]) {
          queried.push(requestIds);
          return new Map([
            [requestIds[0]!, { content: 'the answer', senderPubkey: 'p', decryptionFailed: false }],
          ]);
        },
      },
    };
    const entry: JobLedgerEntry = {
      jobEventId: 'job-c',
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
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverCustomerJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => mockClient,
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;

    await service.recoverCustomerJob(entry);

    expect(queried).toEqual([['job-c']]);
    const latest = await loadLatest(runtime, 'customer');
    const current = latest.get('job-c');
    expect(current?.state).toBe('result_received');
    expect(current?.resultContent).toBe('the answer');
  });

  it('customer submitted job past timeout → failed', async () => {
    const runtime = makeRuntime();
    const entry: JobLedgerEntry = {
      jobEventId: 'job-stale',
      side: 'customer',
      state: 'submitted',
      capability: 'summarization',
      priceLamports: '1000000',
      providerPubkey: 'p',
      transitionAt: Date.now() - 10 * 60 * 1000,
      jobCreatedAt: Date.now() - 10 * 60 * 1000,
      version: 1,
    };
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverCustomerJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => ({
        marketplace: {
          async queryJobResults() {
            return new Map();
          },
        },
      }),
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;

    await service.recoverCustomerJob(entry);

    const latest = await loadLatest(runtime, 'customer');
    expect(latest.get('job-stale')?.state).toBe('failed');
  });

  it('customer payment_sent without result yet leaves the entry non-terminal', async () => {
    const runtime = makeRuntime();
    const entry: JobLedgerEntry = {
      jobEventId: 'job-wait',
      side: 'customer',
      state: 'payment_sent',
      capability: 'summarization',
      priceLamports: '1000000',
      providerPubkey: 'p',
      transitionAt: Date.now() - 1000,
      jobCreatedAt: Date.now() - 2 * 60 * 1000,
      version: 1,
    };
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverCustomerJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => ({
        marketplace: {
          async queryJobResults() {
            return new Map();
          },
        },
      }),
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;

    await service.recoverCustomerJob(entry);

    const latest = await loadLatest(runtime, 'customer');
    expect(latest.get('job-wait')?.state).toBe('payment_sent');
  });

  it('provider executed entry with no cached result marks failed on re-execute error', async () => {
    const runtime = makeRuntime({
      useModel: async () => {
        throw new Error('simulated LLM outage');
      },
    });
    initState(runtime, stubConfig());
    const entry = providerEntry({ state: 'paid', resultContent: undefined });
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverProviderJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
      wallet?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => ({
        marketplace: {
          async submitJobResultWithRetry() {
            return 'should-not-reach';
          },
        },
      }),
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;
    service.wallet = {} as unknown;

    await service.recoverProviderJob(entry);

    const latest = await loadLatest(runtime, 'provider');
    const current = latest.get('job-p');
    // re-execute failure writes an incremented-retry error entry but not
    // a terminal 'failed' state - the next sweep will try again until the
    // retry budget runs out.
    expect(current?.error).toContain('simulated LLM outage');
    expect(current?.state).toBe('paid');
    expect(current?.retryCount ?? 0).toBe(1);
  });

  it('re-execute routes to a skill when capability matches the SkillRegistry', async () => {
    const runtime = makeRuntime();
    initState(runtime, stubConfig());
    const fakeSkill: Skill = {
      name: 'summary',
      description: 'summary',
      capabilities: ['summarization'],
      priceLamports: 1_000_000n,
      async execute(input) {
        return { data: `skill-summary-of:${input.data.length}` };
      },
    };
    const registry = new SkillRegistry();
    registry.register(fakeSkill);
    const state = getState(runtime);
    state.skills = registry;
    state.skillLlm = {} as unknown as LlmClient;

    const entry = providerEntry({ state: 'paid', resultContent: undefined });
    await recordTransition(runtime, entry);

    const submitted: string[] = [];
    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverProviderJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
      wallet?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => ({
        marketplace: {
          async submitJobResultWithRetry(_id: unknown, event: { id: string }, content: string) {
            submitted.push(`${event.id}|${content}`);
            return 'result-event-id';
          },
        },
      }),
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;
    service.wallet = {} as unknown;

    await service.recoverProviderJob(entry);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('skill-summary-of:');
    const latest = await loadLatest(runtime, 'provider');
    expect(latest.get('job-p')?.state).toBe('delivered');
  });

  it('re-execute fails the job when a skill matches but skillLlm is not configured', async () => {
    const runtime = makeRuntime();
    initState(runtime, stubConfig());
    const fakeSkill: Skill = {
      name: 'summary',
      description: 'summary',
      capabilities: ['summarization'],
      priceLamports: 1_000_000n,
      async execute() {
        throw new Error('should not reach skill.execute');
      },
    };
    const registry = new SkillRegistry();
    registry.register(fakeSkill);
    getState(runtime).skills = registry;

    const entry = providerEntry({ state: 'paid', resultContent: undefined });
    await recordTransition(runtime, entry);

    const RecoveryService = await loadService();
    const service = new (RecoveryService as unknown as new (rt: IAgentRuntime) => {
      recoverProviderJob: (e: JobLedgerEntry) => Promise<void>;
      elisym?: unknown;
      wallet?: unknown;
    })(runtime);
    service.elisym = {
      getClient: () => ({
        marketplace: {
          async submitJobResultWithRetry() {
            throw new Error('should not reach submit');
          },
        },
      }),
      getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'p' }),
    } as unknown;
    service.wallet = {} as unknown;

    await service.recoverProviderJob(entry);

    const latest = await loadLatest(runtime, 'provider');
    const current = latest.get('job-p');
    expect(current?.state).toBe('failed');
    expect(current?.error).toContain('ANTHROPIC_API_KEY');
  });
});
