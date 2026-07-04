/** CAIP-2 id of Solana devnet (genesis-hash form) - the canonical x402 v2 network id. */
export const X402_SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** x402 v1 alias for Solana devnet (pre-CAIP string networks). */
export const X402_SOLANA_DEVNET_V1 = 'solana-devnet';

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
 * Maximum paid attempts per job (first + one retry). x402 is
 * pay-then-respond: a transient failure AFTER settlement means the money is
 * gone; this bounds the operator's worst case at 2x the upstream price.
 */
export const X402_MAX_PAID_ATTEMPTS = 2;

/** Idempotency-cache retention; must exceed the 24h paid-job recovery cutoff. */
export const X402_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
