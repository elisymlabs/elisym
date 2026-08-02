import type { Network } from '@elisym/sdk';

/** CAIP-2 id of Solana devnet (genesis-hash form) - the canonical x402 v2 network id. */
export const X402_SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** x402 v1 alias for Solana devnet (pre-CAIP string networks). */
export const X402_SOLANA_DEVNET_V1 = 'solana-devnet';

/** CAIP-2 id of Solana mainnet (genesis-hash form) - the canonical x402 v2 network id. */
export const X402_SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * x402 v1 alias for Solana mainnet. Verified against the installed
 * `@x402/svm` (`V1_TO_V2_NETWORK_MAP` in its constants: `solana` maps to the
 * mainnet CAIP-2, `solana-devnet` to devnet).
 */
export const X402_SOLANA_MAINNET_V1 = 'solana';

/**
 * The x402 network identifiers (v2 CAIP-2 + v1 alias) for the agent's Solana
 * network. Single source for the matcher's accepted-id set and the driver's
 * scheme registration, so the two can never drift apart. The caip2 member
 * keeps the `namespace:reference` template shape `@x402`'s scheme config
 * requires.
 */
export function x402SolanaNetworkIds(network: Network): {
  caip2: `${string}:${string}`;
  v1: string;
} {
  return network === 'mainnet'
    ? { caip2: X402_SOLANA_MAINNET_CAIP2, v1: X402_SOLANA_MAINNET_V1 }
    : { caip2: X402_SOLANA_DEVNET_CAIP2, v1: X402_SOLANA_DEVNET_V1 };
}

/**
 * Ceiling on a GET input AFTER percent-encoding (bytes). Query strings above
 * ~8KB are rejected by most servers with 414/400; enforcing well under that
 * BEFORE the customer pays turns a paid-then-failed job into a free refusal.
 */
export const X402_GET_INPUT_MAX_ENCODED_BYTES = 2_048;

/** Cap on the buffered upstream response body. The upstream is untrusted. */
export const X402_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Cap on a 402 challenge body during the payment handshake. The `@x402/fetch`
 * wrapper reads the initial 402 body uncapped to parse the requirements; a
 * hostile upstream could send a small 402 on probes but a giant one on the
 * paid call. A real challenge is a tiny JSON document, so 256 KiB is ample.
 */
export const X402_MAX_CHALLENGE_BYTES = 256 * 1024;

/** TTL of the unpaid 402 probe cache shared across concurrent jobs. */
export const X402_PROBE_TTL_MS = 30_000;

/**
 * Maximum DURABLE paid attempts per job (first + one retry). x402 is
 * pay-then-respond: a transient failure AFTER settlement means the money is
 * gone; this bounds the operator's steady-state worst case at 2x the
 * upstream price. A slot is refunded only when the upstream answers the
 * signed payment with a definitive 402 refusal (an honest upstream did not
 * settle - the money never moved); every other paid outcome (success, 5xx,
 * network error, crash) keeps its slot.
 */
export const X402_MAX_PAID_ATTEMPTS = 2;

/**
 * Hard monotonic cap on SIGNED payments per job: every PAYMENT-SIGNATURE
 * request that leaves the process counts, and the count is never refunded.
 * Needed because the 402-refusal refund above trusts the upstream's status
 * code - a malicious upstream can settle the payment AND respond 402 to
 * farm refunds. This cap is the true adversarial money bound per job (each
 * signature is itself capped by `x402_max_upstream`), the price of
 * tolerating expired-blockhash 402s from slow verify->serve->settle
 * upstreams.
 */
export const X402_MAX_PAYMENT_SIGNATURES = 2 * X402_MAX_PAID_ATTEMPTS;

/**
 * Inline retry backoff for MONEY-FREE transient failures (no payment left
 * the process in the failed attempt): network errors and 429/5xx on the
 * unpaid request. One entry per retry. Money-unknown transients (network
 * error or 5xx AFTER a payment went out) never retry inline - they stay
 * with the recovery loop.
 */
export const X402_FREE_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Inline retries after a refunded 402 payment refusal, taken immediately:
 * the dominant honest cause is a transaction blockhash that expired while a
 * slow upstream served before settling, and the fix is signing with a fresh
 * blockhash - waiting would only re-create the expiry.
 */
export const X402_REFUNDED_RETRIES = 1;

/** Idempotency-cache retention; must exceed the 24h paid-job recovery cutoff. */
export const X402_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
