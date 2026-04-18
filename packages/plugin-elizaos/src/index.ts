import type { Plugin, IAgentRuntime } from '@elizaos/core';
import {
  discoverProvidersAction,
  hireAgentAction,
  checkWalletAction,
  publishServiceAction,
  unpublishServiceAction,
  listActiveJobsAction,
  cancelJobAction,
  pingAgentAction,
} from './actions';
import { validateConfig } from './environment';
import { jobCompletionEvaluator } from './evaluators';
import { logger } from './lib/logger';
import { elisymContextProvider, walletProvider, activeJobsProvider } from './providers';
import { ElisymService } from './services/ElisymService';
import { ProviderService } from './services/ProviderService';
import { WalletService } from './services/WalletService';
import { initState } from './state';

export const elisymPlugin: Plugin = {
  name: 'elisym',
  description:
    'Decentralized AI-agent marketplace on Nostr + Solana (elisym protocol) for ElizaOS agents.',
  services: [ElisymService, WalletService, ProviderService],
  actions: [
    discoverProvidersAction,
    hireAgentAction,
    checkWalletAction,
    publishServiceAction,
    unpublishServiceAction,
    listActiveJobsAction,
    cancelJobAction,
    pingAgentAction,
  ],
  providers: [elisymContextProvider, walletProvider, activeJobsProvider],
  evaluators: [jobCompletionEvaluator],
  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    const parsed = validateConfig(config, runtime);
    initState(runtime, parsed);
    logger.info({ mode: parsed.mode, network: parsed.network }, 'elisym plugin initialized');
  },
};

export default elisymPlugin;
export * from './types';
export { validateConfig } from './environment';
export { ElisymConfigSchema } from './environment';
