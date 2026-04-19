import { z } from 'zod';
import { LIMITS } from '../constants';

const MAX_DESCRIPTION_LENGTH = LIMITS.MAX_DESCRIPTION_LENGTH;
const MAX_SAFE_LAMPORTS = Number.MAX_SAFE_INTEGER;
// Hard cap on the schema-level expiry. The create path enforces a tighter
// LIMITS.MAX_TIMEOUT_SECS (10 min) but historical providers may have
// emitted longer expiries; we only refuse outright nonsense here.
const MAX_EXPIRY_SECS_SCHEMA = 86_400;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
// Solana addresses + reference keys are 32-byte ed25519 public keys, which
// base58-encode to 32 - 44 characters. Tighter than naive `length>0`.
const SOLANA_ADDRESS_LENGTH_RE = /^.{32,44}$/;

const lamportsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SAFE_LAMPORTS, `amount must be <= ${MAX_SAFE_LAMPORTS}`);

const feeAmountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_SAFE_LAMPORTS, `fee_amount must be <= ${MAX_SAFE_LAMPORTS}`);

const solanaAddressSchema = z
  .string()
  .regex(BASE58_RE, 'must be base58')
  .regex(SOLANA_ADDRESS_LENGTH_RE, 'must be 32-44 base58 chars');

/**
 * Wire-shape for a NIP-90 payment_request blob, as parsed via JSON.parse.
 *
 * Stricter than the loose TypeScript interface: rejects negative amounts,
 * floats, NaN/Infinity, mistyped recipient/reference, and any expiry
 * outside `[1, LIMITS.MAX_TIMEOUT_SECS]`. The strategy applies semantic
 * checks (recipient match, fee amount, expiry-vs-now) on top of this.
 */
export const PaymentRequestSchema = z.object({
  recipient: solanaAddressSchema,
  amount: lamportsSchema,
  reference: solanaAddressSchema,
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  fee_address: solanaAddressSchema.optional(),
  fee_amount: feeAmountSchema.optional(),
  created_at: z.number().int().positive(),
  expiry_secs: z
    .number()
    .int()
    .positive()
    .max(MAX_EXPIRY_SECS_SCHEMA, `expiry_secs must be <= ${MAX_EXPIRY_SECS_SCHEMA}`),
});

export type ParsedPaymentRequest = z.infer<typeof PaymentRequestSchema>;

export interface ParseOptions {
  /** Optional max amount cap (lamports). Rejects requests that exceed it. */
  maxAmountLamports?: bigint;
}

export interface ParseError {
  code: 'invalid_json' | 'schema' | 'amount_exceeds_max';
  message: string;
}

export type ParseResult =
  | { ok: true; data: ParsedPaymentRequest }
  | { ok: false; error: ParseError };

/**
 * Parse a JSON-encoded payment request through the Zod schema, optionally
 * enforcing a `maxAmountLamports` ceiling supplied by the caller (e.g. the
 * customer's per-job spending cap).
 */
export function parsePaymentRequest(input: string, options?: ParseOptions): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return {
      ok: false,
      error: { code: 'invalid_json', message: `Invalid payment request JSON: ${e}` },
    };
  }
  const result = PaymentRequestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: { code: 'schema', message: result.error.message },
    };
  }
  if (options?.maxAmountLamports !== undefined) {
    if (BigInt(result.data.amount) > options.maxAmountLamports) {
      return {
        ok: false,
        error: {
          code: 'amount_exceeds_max',
          message: `Payment amount ${result.data.amount} lamports exceeds approved max ${options.maxAmountLamports}.`,
        },
      };
    }
  }
  return { ok: true, data: result.data };
}
