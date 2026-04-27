import type { Address } from '@solana/kit';

export const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
];

export const KIND_APP_HANDLER = 31990;
export const KIND_JOB_REQUEST_BASE = 5000;
export const KIND_JOB_RESULT_BASE = 6000;
export const KIND_JOB_FEEDBACK = 7000;
export const DEFAULT_KIND_OFFSET = 100;

/** Default job request kind (5000 + 100). */
export const KIND_JOB_REQUEST = KIND_JOB_REQUEST_BASE + DEFAULT_KIND_OFFSET;
/** Default job result kind (6000 + 100). */
export const KIND_JOB_RESULT = KIND_JOB_RESULT_BASE + DEFAULT_KIND_OFFSET;

/** Compute a job request kind from an offset (5000 + offset). */
export function jobRequestKind(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset >= 1000) {
    throw new Error(`Invalid kind offset: ${offset}. Must be integer 0-999.`);
  }
  return KIND_JOB_REQUEST_BASE + offset;
}

/** Compute a job result kind from an offset (6000 + offset). */
export function jobResultKind(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset >= 1000) {
    throw new Error(`Invalid kind offset: ${offset}. Must be integer 0-999.`);
  }
  return KIND_JOB_RESULT_BASE + offset;
}

/** Ephemeral ping/pong kinds (not stored by relays, forwarded in real-time). */
export const KIND_PING = 20200;
export const KIND_PONG = 20201;

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Solana program ID for the elisym protocol config (devnet deployment).
 *
 * The Anchor program at this address is the source of truth for fee bps,
 * treasury address, and admin rotation state. Read via `getProtocolConfig`.
 */
export const PROTOCOL_PROGRAM_ID_DEVNET = 'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE' as Address;

/**
 * Read-only marker pubkey attached as a non-signer account to every elisym
 * payment transaction. Lets indexers enumerate every elisym tx network-wide
 * via a single `getSignaturesForAddress(ELISYM_PROTOCOL_TAG)` call,
 * independent of fee size or recipient.
 *
 * The account does not need to exist on-chain; including its pubkey as an
 * extra read-only account in the provider transfer instruction is enough for
 * Solana's tx-by-account index to pick it up. The corresponding secret key
 * was generated and discarded - the tag never signs and never holds funds.
 */
export const ELISYM_PROTOCOL_TAG = 'ELiZksgwDt41LaeuPDLkUfWgFXhGgVayTMP7L5nTSEL8' as Address;

export type ProtocolCluster = 'devnet' | 'mainnet' | 'localnet';

/**
 * Resolve the elisym-config program ID for a given Solana cluster.
 * Mainnet is intentionally unsupported until the program ships there.
 */
export function getProtocolProgramId(cluster: ProtocolCluster): Address {
  switch (cluster) {
    case 'devnet':
    case 'localnet':
      return PROTOCOL_PROGRAM_ID_DEVNET;
    case 'mainnet':
      throw new Error('Protocol program is not deployed on mainnet yet');
  }
}

/** Default values for timeouts, retries, and batch sizes. */
export const DEFAULTS = {
  SUBSCRIPTION_TIMEOUT_MS: 120_000,
  PING_TIMEOUT_MS: 3_000,
  PING_RETRIES: 2,
  PING_CACHE_TTL_MS: 30_000,
  PAYMENT_EXPIRY_SECS: 600,
  BATCH_SIZE: 250,
  QUERY_TIMEOUT_MS: 15_000,
  EOSE_TIMEOUT_MS: 3_000,
  VERIFY_RETRIES: 10,
  VERIFY_INTERVAL_MS: 3_000,
  VERIFY_BY_REF_RETRIES: 15,
  VERIFY_BY_REF_INTERVAL_MS: 2_000,
  RESULT_RETRY_COUNT: 3,
  RESULT_RETRY_BASE_MS: 1_000,
  QUERY_MAX_CONCURRENCY: 6,
  VERIFY_SIGNATURE_LIMIT: 25,
} as const;

/** Protocol limits for input validation. */
export const LIMITS = {
  MAX_INPUT_LENGTH: 100_000,
  MAX_TIMEOUT_SECS: 600,
  MAX_CAPABILITIES: 20,
  MAX_DESCRIPTION_LENGTH: 500,
  MAX_AGENT_NAME_LENGTH: 64,
  MAX_CAPABILITY_LENGTH: 64,
} as const;
