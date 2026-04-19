import { KIND_JOB_REQUEST } from '@elisym/sdk';
import type { Action, ActionResult, IAgentRuntime } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import type { ElisymService } from '../services/ElisymService';
import type { WalletService } from '../services/WalletService';
import { getState, hasState } from '../state';

export const publishServiceAction: Action = {
  name: 'ELISYM_PUBLISH_SERVICE',
  similes: ['PUBLISH_CAPABILITY', 'ANNOUNCE_AGENT'],
  description: "Publish or re-publish this agent's capabilities to the elisym network.",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    if (!hasState(runtime)) {
      return false;
    }
    const { config } = getState(runtime);
    return !!config.providerCapabilities?.length && !!config.providerPriceLamports;
  },
  handler: async (runtime, _message, _state, _options, callback): Promise<ActionResult> => {
    const { config } = getState(runtime);
    const elisym = runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    const wallet = runtime.getService<WalletService>(SERVICE_TYPES.WALLET);
    if (!elisym || !wallet) {
      throw new Error('Elisym/Wallet services must be running');
    }
    if (!config.providerCapabilities || !config.providerPriceLamports) {
      throw new Error('Provider mode misconfigured');
    }
    const character = runtime.character;
    const name = character?.name ?? 'elizaos-agent';
    const description = (character?.system ?? '').slice(0, 500) || 'ElizaOS agent on elisym';
    const eventId = await elisym.getClient().discovery.publishCapability(
      elisym.getIdentity(),
      {
        name,
        description,
        capabilities: [...config.providerCapabilities],
        payment: {
          chain: 'solana',
          network: config.network,
          address: wallet.address,
          job_price: Number(config.providerPriceLamports),
        },
      },
      [KIND_JOB_REQUEST],
    );
    await callback?.({
      text: `Published capability card (event ${eventId.slice(0, 8)}).`,
      source: 'elisym',
    });
    return { success: true, data: { eventId } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Re-announce my services on elisym' } },
      {
        name: '{{agent}}',
        content: { text: 'Publishing capability card...', actions: ['ELISYM_PUBLISH_SERVICE'] },
      },
    ],
  ],
};
