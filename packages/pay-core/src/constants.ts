/**
 * What the money core counts in.
 *
 * The protocol's own identity - the config program, the marker every elisym
 * payment transaction carries - and the numbers a payment is bounded by. The
 * SDK spreads `PAYMENT_DEFAULTS` and `PAYMENT_LIMITS` into its own `DEFAULTS`
 * and `LIMITS`, so each value is written once and every consumer still reads
 * it where it always did.
 */

import type { Address } from '@solana/kit';

/**
 * Solana program ID for the elisym protocol config (devnet deployment).
 *
 * The Anchor program at this address is the source of truth for fee bps,
 * treasury address, and admin rotation state. Read via `getProtocolConfig`.
 */
export const PROTOCOL_PROGRAM_ID_DEVNET = 'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE' as Address;

/**
 * Solana program ID for the elisym protocol config (mainnet deployment).
 *
 * Deliberately the same address as devnet - the program was deployed to
 * mainnet with the same program keypair (plan D4). The constants stay
 * per-cluster so a future divergence (or a localnet deployment) is a
 * one-line change, but the program id alone no longer identifies a
 * cluster: every program-id-keyed cache carries a network discriminator.
 */
export const PROTOCOL_PROGRAM_ID_MAINNET =
  'BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE' as Address;

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

/** Resolve the elisym-config program ID for a given Solana cluster. */
export function getProtocolProgramId(cluster: ProtocolCluster): Address {
  switch (cluster) {
    case 'devnet':
    case 'localnet':
      return PROTOCOL_PROGRAM_ID_DEVNET;
    case 'mainnet':
      return PROTOCOL_PROGRAM_ID_MAINNET;
  }
}

/** The Solana system program, as a string: no import, no runtime cost. */
export const SYSTEM_PROGRAM_ADDRESS_STR = '11111111111111111111111111111111';

/** The compute-budget program, as a string, for the same reason. */
export const COMPUTE_BUDGET_PROGRAM_ADDRESS_STR = 'ComputeBudget111111111111111111111111111111';

/** Timings a payment is made and verified with. */
export const PAYMENT_DEFAULTS = {
  PAYMENT_EXPIRY_SECS: 600,
  VERIFY_RETRIES: 10,
  VERIFY_INTERVAL_MS: 3_000,
  VERIFY_BY_REF_RETRIES: 15,
  VERIFY_BY_REF_INTERVAL_MS: 2_000,
  QUERY_MAX_CONCURRENCY: 6,
  VERIFY_SIGNATURE_LIMIT: 25,
} as const;

/** Bounds a payment request is read against. */
export const PAYMENT_LIMITS = {
  MAX_DESCRIPTION_LENGTH: 500,
  /** The longest a payment request may stay payable. Also the result-wait cap. */
  MAX_TIMEOUT_SECS: 600,
} as const;
