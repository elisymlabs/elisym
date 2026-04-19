import type { Route } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import type { ElisymService } from '../services/ElisymService';
import type { WalletService } from '../services/WalletService';
import { getState, hasState } from '../state';

interface HealthPayload {
  status: 'ok' | 'degraded' | 'uninitialized';
  agent?: {
    npub?: string;
    address?: string;
    network: string;
  };
  wallet?: {
    address?: string;
  };
  shuttingDown?: boolean;
}

export const healthRoute: Route = {
  type: 'GET',
  path: '/plugins/elisym/health',
  name: 'elisym-health',
  public: true,
  handler: async (_req, res, runtime): Promise<void> => {
    if (!hasState(runtime)) {
      res.status(503).json({ status: 'uninitialized' });
      return;
    }
    const state = getState(runtime);
    const elisym = runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    const wallet = runtime.getService<WalletService>(SERVICE_TYPES.WALLET);
    const payload: HealthPayload = {
      status: state.shuttingDown ? 'degraded' : 'ok',
      agent: {
        npub: elisym?.getIdentity?.()?.publicKey,
        address: wallet?.address,
        network: state.config.network,
      },
      wallet: {
        address: wallet?.address,
      },
      shuttingDown: state.shuttingDown ?? false,
    };
    res.status(200).json(payload);
  },
};
