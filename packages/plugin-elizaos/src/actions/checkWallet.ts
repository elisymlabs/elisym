import type { Action, ActionResult, IAgentRuntime } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import { formatLamportsAsSol } from '../lib/pricing';
import type { WalletService } from '../services/WalletService';
import { getState, hasState } from '../state';

export const checkWalletAction: Action = {
  name: 'ELISYM_CHECK_WALLET',
  similes: ['WALLET_BALANCE', 'SHOW_WALLET'],
  description: "Show this agent's Solana address, SOL balance, and current spending bucket usage.",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => hasState(runtime),
  handler: async (runtime, _message, _state, _options, callback): Promise<ActionResult> => {
    const { config } = getState(runtime);
    const wallet = runtime.getService<WalletService>(SERVICE_TYPES.WALLET);
    if (!wallet) {
      throw new Error('WalletService is not running');
    }
    const balance = await wallet.getBalance();
    const spent = wallet.hourlyTotal();
    const text = [
      `Address: ${wallet.address}`,
      `Network: ${config.network}`,
      `Balance: ${formatLamportsAsSol(balance)} SOL`,
      `Spent (last hour): ${formatLamportsAsSol(spent)} of ${formatLamportsAsSol(config.maxSpendPerHourLamports)} SOL`,
    ].join('\n');
    await callback?.({ text, source: 'elisym' });
    return {
      success: true,
      data: { address: wallet.address, balanceLamports: balance.toString() },
    };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Check my elisym wallet' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Fetching balance...',
          actions: ['ELISYM_CHECK_WALLET'],
        },
      },
    ],
  ],
};
