import type { Plugin, IAgentRuntime, Service } from '@elizaos/core';
import {
  checkWalletAction,
  publishServiceAction,
  unpublishServiceAction,
  cleanupJobsAction,
} from './actions';
import { SERVICE_TYPES, SHUTDOWN_DRAIN_TIMEOUT_MS } from './constants';
import { validateConfig } from './environment';
import { logger } from './lib/logger';
import { registerDefaultMetrics } from './lib/metrics';
import { elisymContextProvider, walletProvider } from './providers';
import { healthRoute } from './routes/health';
import { metricsRoute } from './routes/metrics';
import { ElisymService } from './services/ElisymService';
import { ProviderService } from './services/ProviderService';
import { RecoveryService } from './services/RecoveryService';
import { WalletService } from './services/WalletService';
import { getState, initState } from './state';

const SHUTDOWN_HOOK_KEY = Symbol.for('elisym.shutdownHookRegistered');
type GlobalWithHook = typeof globalThis & { [SHUTDOWN_HOOK_KEY]?: boolean };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ label, ms }, 'shutdown step exceeded timeout');
      resolve(undefined);
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        logger.warn({ err: error, label }, 'shutdown step threw');
        resolve(undefined);
      });
  });
}

async function gracefulShutdown(runtime: IAgentRuntime, signal: string): Promise<void> {
  try {
    const state = getState(runtime);
    if (state.shuttingDown) {
      return;
    }
    state.shuttingDown = true;
    logger.info({ signal }, 'elisym plugin graceful shutdown initiated');
  } catch {
    // Plugin state may not be initialized yet; nothing to drain.
    return;
  }
  const types = [
    SERVICE_TYPES.RECOVERY,
    SERVICE_TYPES.PROVIDER,
    SERVICE_TYPES.WALLET,
    SERVICE_TYPES.ELISYM,
  ];
  for (const type of types) {
    const instance = runtime.getService<Service>(type);
    if (!instance) {
      continue;
    }
    await withTimeout(instance.stop(), SHUTDOWN_DRAIN_TIMEOUT_MS, `stop:${type}`);
  }
  logger.info('elisym plugin graceful shutdown complete');
}

function registerShutdownHook(runtime: IAgentRuntime): void {
  const g = globalThis as GlobalWithHook;
  if (g[SHUTDOWN_HOOK_KEY]) {
    return;
  }
  g[SHUTDOWN_HOOK_KEY] = true;
  const onSignal = (signal: string): void => {
    gracefulShutdown(runtime, signal).catch((error) =>
      logger.warn({ err: error }, 'gracefulShutdown threw'),
    );
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}

export const elisymPlugin: Plugin = {
  name: 'elisym',
  description:
    'ElizaOS plugin for running a paid elisym provider agent (Nostr + Solana). Customer-side flows (discovery, hire, payment) are intentionally omitted - use @elisym/mcp or @elisym/cli for those.',
  services: [ElisymService, WalletService, ProviderService, RecoveryService],
  actions: [checkWalletAction, publishServiceAction, unpublishServiceAction, cleanupJobsAction],
  providers: [elisymContextProvider, walletProvider],
  routes: [healthRoute, metricsRoute],
  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    const parsed = validateConfig(config, runtime);
    initState(runtime, parsed);
    registerDefaultMetrics();
    registerShutdownHook(runtime);
    logger.info({ network: parsed.network }, 'elisym plugin initialized');
  },
};

export default elisymPlugin;
export * from './types';
export { validateConfig } from './environment';
export { ElisymConfigSchema } from './environment';
