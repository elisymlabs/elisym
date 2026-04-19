import type { Provider } from '@elizaos/core';
import { hasState, getState } from '../state';

export const elisymContextProvider: Provider = {
  name: 'ELISYM_CONTEXT',
  description:
    'Exposes the provider agent identity, network, and published capabilities to the planner.',
  position: 100,
  get: async (runtime) => {
    if (!hasState(runtime)) {
      return { text: '', values: {}, data: {} };
    }
    const { config, identity } = getState(runtime);
    const lines = ['# Elisym network', `Network: ${config.network}.`];
    if (identity) {
      lines.push(`Agent npub: ${identity.npub}`);
    }
    if (config.providerCapabilities) {
      lines.push(`Published capabilities: ${config.providerCapabilities.join(', ')}.`);
    }
    return {
      text: lines.join('\n'),
      values: {
        network: config.network,
        pubkey: identity?.publicKey ?? '',
      },
      data: {},
    };
  },
};
