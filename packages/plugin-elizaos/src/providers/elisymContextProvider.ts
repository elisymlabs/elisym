import type { Provider } from '@elizaos/core';
import { hasState, getState } from '../state';

export const elisymContextProvider: Provider = {
  name: 'ELISYM_CONTEXT',
  description: 'Exposes the agent identity, network, and mode to the planner.',
  position: 100,
  get: async (runtime) => {
    if (!hasState(runtime)) {
      return { text: '', values: {}, data: {} };
    }
    const { config, identity } = getState(runtime);
    const lines = ['# Elisym network', `Mode: ${config.mode}. Network: ${config.network}.`];
    if (identity) {
      lines.push(`Agent npub: ${identity.npub}`);
    }
    if (config.mode !== 'customer' && config.providerCapabilities) {
      lines.push(`Published capabilities: ${config.providerCapabilities.join(', ')}.`);
    }
    return {
      text: lines.join('\n'),
      values: {
        network: config.network,
        mode: config.mode,
        pubkey: identity?.publicKey ?? '',
      },
      data: {},
    };
  },
};
