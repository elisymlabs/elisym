import type { IAgentRuntime } from '@elizaos/core';
import { recordTransition, type JobLedgerEntry } from '../../src/lib/jobLedger';
import type { RecoveryService } from '../../src/services/RecoveryService';
import { FakeClient } from './fakeClient';
import { bootState, makeStubRuntime, type StubRuntime } from './runtime';

export interface RecoveryHarness {
  runtime: StubRuntime;
  client: FakeClient;
  service: RecoveryService;
  sweep: () => Promise<void>;
  seed: (entry: JobLedgerEntry) => Promise<void>;
}

export interface HarnessOptions {
  client?: FakeClient;
  wallet?: unknown;
  useModel?: (type: string, params: { prompt: string }) => Promise<string>;
  config?: Parameters<typeof bootState>[1];
  actions?: IAgentRuntime['actions'];
}

export async function createRecoveryHarness(
  options: HarnessOptions = {},
): Promise<RecoveryHarness> {
  const runtime = makeStubRuntime({
    actions: options.actions,
    useModel: options.useModel,
  });
  bootState(runtime, options.config);

  const client = options.client ?? new FakeClient();
  const wallet = options.wallet;

  const elisymStub = {
    getClient: () => client,
    getIdentity: () => ({ secretKey: new Uint8Array(32), publicKey: 'agent-pk' }),
  };

  const RecoveryServiceMod = await import('../../src/services/RecoveryService');
  const ServiceCtor = RecoveryServiceMod.RecoveryService as unknown as new (
    rt: IAgentRuntime,
  ) => RecoveryService & {
    elisym?: unknown;
    wallet?: unknown;
    sweepOnce: () => Promise<void>;
  };
  const service = new ServiceCtor(runtime);
  (service as unknown as { elisym: unknown }).elisym = elisymStub;
  (service as unknown as { wallet: unknown }).wallet = wallet ?? {};

  return {
    runtime,
    client,
    service,
    sweep: () => (service as unknown as { sweepOnce: () => Promise<void> }).sweepOnce(),
    seed: (entry: JobLedgerEntry) => recordTransition(runtime, entry),
  };
}
