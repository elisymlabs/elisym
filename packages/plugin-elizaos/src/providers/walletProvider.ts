import type { Provider } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import { logger } from '../lib/logger';
import { formatLamportsAsSol } from '../lib/pricing';
import type { WalletService } from '../services/WalletService';
import { getState, hasState } from '../state';

export const walletProvider: Provider = {
  name: 'ELISYM_WALLET',
  description: 'Current provider Solana address and SOL balance.',
  position: 50,
  dynamic: true,
  get: async (runtime) => {
    if (!hasState(runtime)) {
      return { text: '', values: {}, data: {} };
    }
    const { config } = getState(runtime);
    const wallet = runtime.getService<WalletService>(SERVICE_TYPES.WALLET);
    if (!wallet) {
      return { text: '', values: {}, data: {} };
    }
    try {
      const balance = await wallet.getBalance();
      const text = `Wallet ${wallet.address.slice(0, 8)}... holds ${formatLamportsAsSol(balance)} SOL (${config.network}).`;
      return {
        text,
        values: {
          balanceLamports: balance.toString(),
          address: wallet.address,
        },
        data: {},
      };
    } catch (error) {
      logger.warn({ err: error }, 'walletProvider balance fetch failed');
      return { text: 'Wallet balance currently unavailable.', values: {}, data: {} };
    }
  },
};
