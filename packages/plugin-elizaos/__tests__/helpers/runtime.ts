import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import type { ElisymConfig } from '../../src/environment';
import { initState } from '../../src/state';

export interface RuntimeMocks {
  actions?: IAgentRuntime['actions'];
  useModel?: (type: string, params: { prompt: string }) => Promise<string>;
  getServiceLoadPromise?: (type: string) => Promise<unknown>;
  getService?: <T = unknown>(type: string) => T | null;
}

export type StubRuntime = IAgentRuntime & {
  _store: Map<string, Memory[]>;
  _deleted: Set<string>;
};

export function makeStubRuntime(mocks: RuntimeMocks = {}): StubRuntime {
  const store = new Map<string, Memory[]>();
  const deleted = new Set<string>();
  let nextId = 1;
  const agentId = '00000000-0000-0000-0000-000000000099' as UUID;
  return {
    agentId,
    character: { name: 'Tester', bio: 'integration', system: 'integration system' },
    actions: mocks.actions ?? [],
    _store: store,
    _deleted: deleted,
    async useModel(_type: string, params: { prompt: string }) {
      return mocks.useModel
        ? mocks.useModel(_type, params)
        : `processed: ${params.prompt.slice(-20)}`;
    },
    async getServiceLoadPromise(type: string) {
      return mocks.getServiceLoadPromise ? mocks.getServiceLoadPromise(type) : undefined;
    },
    getService<T = unknown>(type: string): T | null {
      return mocks.getService ? (mocks.getService<T>(type) ?? null) : null;
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
    async deleteMemory(id: string) {
      deleted.add(id);
      for (const [tableName, memories] of store) {
        const filtered = memories.filter((memory) => memory.id !== id);
        store.set(tableName, filtered);
      }
    },
    getSetting() {
      return undefined;
    },
  } as unknown as StubRuntime;
}

export function bootState(runtime: IAgentRuntime, overrides: Partial<ElisymConfig> = {}): void {
  const stub: ElisymConfig = {
    network: 'devnet',
    signerKind: 'local',
    ...overrides,
  } as unknown as ElisymConfig;
  initState(runtime, stub);
}
