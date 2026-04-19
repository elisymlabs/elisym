export const PLUGIN_NAME = 'elisym';

export const SERVICE_TYPES = {
  ELISYM: 'elisym',
  WALLET: 'elisym-wallet',
  PROVIDER: 'elisym-provider',
  RECOVERY: 'elisym-recovery',
} as const;

export const JOBS_MEMORY_TABLE = 'elisym_jobs';
export const SPEND_MEMORY_TABLE = 'elisym_spend';

export const JOB_LEDGER_VERSION = 1;
export const JOB_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;
export const RECOVERY_MAX_RETRIES = 5;
export const RECOVERY_CONCURRENCY = 4;
export const MAX_CONCURRENT_INCOMING_JOBS = 10;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

export const DEFAULT_JOB_TIMEOUT_MS = 180_000;

export const FEE_RESERVE_LAMPORTS = 200_000n;

export const HOUR_MS = 3_600_000;

export const MAX_INCOMING_JOB_BYTES = 64 * 1024;

export const DEFAULT_FETCH_MAX_BYTES = 4 * 1024 * 1024;

export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

export const WATCHDOG_PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const WATCHDOG_PROBE_TIMEOUT_MS = 10_000;
export const WATCHDOG_SELF_PING_INTERVAL_MS = 10 * 60 * 1000;
export const WATCHDOG_SELF_PING_TIMEOUT_MS = 15_000;

export const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEFAULT_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

export const IDENTITY_MEMORY_TABLE = 'elisym_identity';
export const WALLET_MEMORY_TABLE = 'elisym_wallet';

export const PRIORITY_FEE_PERCENTILE = 75;
export const COMPUTE_UNIT_LIMIT = 200_000;
export const PRIORITY_FEE_CACHE_MS = 10_000;

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_PER_WINDOW = 20;
export const MAX_TRACKED_CUSTOMERS = 1000;
