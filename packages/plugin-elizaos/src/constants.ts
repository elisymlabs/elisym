export const PLUGIN_NAME = 'elisym';

export const SERVICE_TYPES = {
  ELISYM: 'elisym',
  WALLET: 'elisym-wallet',
  PROVIDER: 'elisym-provider',
} as const;

export const DEFAULT_JOB_TIMEOUT_MS = 180_000;

export const FEE_RESERVE_LAMPORTS = 200_000n;

export const HOUR_MS = 3_600_000;

export const MAX_INCOMING_JOB_BYTES = 64 * 1024;

export const DEFAULT_FETCH_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEFAULT_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

export const IDENTITY_MEMORY_TABLE = 'elisym_identity';
export const WALLET_MEMORY_TABLE = 'elisym_wallet';
