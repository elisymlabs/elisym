import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { HostedConfig } from '../../src/hosted/lib/hosted-config';
import type { Meta, StoreView } from '../../src/hosted/lib/types';

export const OPERATOR = 'paycore.example';
export const CONFIG: HostedConfig = { apiBase: 'https://api.paycore.example', operator: OPERATOR };

export const META: Meta = {
  publicBase: CONFIG.apiBase,
  operator: OPERATOR,
  networks: { mainnet: { coins: [] }, devnet: { coins: [] } },
  inboxRelays: ['wss://relay.example'],
  pendingMaxProducts: 20,
};

export const OWNER_KEY = generateSecretKey();
export const OWNER = getPublicKey(OWNER_KEY);
export const STORE_PUBKEY = getPublicKey(generateSecretKey());

export function storeView(overrides: Partial<StoreView> = {}): StoreView {
  return {
    owner: OWNER,
    storePubkey: STORE_PUBKEY,
    status: 'pending',
    alerts: [],
    tier: null,
    maxProducts: 20,
    suspendingSince: null,
    createdAt: 1_800_000_000,
    config: null,
    activePayouts: null,
    webhookSecretSet: false,
    payouts: { needsSigning: false },
    ownerEvents: { payto: null, auth: null },
    ...overrides,
  };
}
