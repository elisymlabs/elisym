import { z } from 'zod';
import { PAYMENT_LIMITS } from '../constants';

const MAX_DESCRIPTION_LENGTH = PAYMENT_LIMITS.MAX_DESCRIPTION_LENGTH;
const MAX_SAFE_LAMPORTS = Number.MAX_SAFE_INTEGER;
// Hard cap on the schema-level expiry. The create path enforces a tighter
// PAYMENT_LIMITS.MAX_TIMEOUT_SECS (10 min) but historical providers may have
// emitted longer expiries; we only refuse outright nonsense here.
const MAX_EXPIRY_SECS_SCHEMA = 86_400;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
// Solana addresses + reference keys are 32-byte ed25519 public keys, which
// base58-encode to 32 - 44 characters. Tighter than naive `length>0`.
const SOLANA_ADDRESS_LENGTH_RE = /^.{32,44}$/;
/**
 * How many failed fields a schema rejection names before it stops and reports a
 * count. A hostile provider can fail every field at once; the message ends up in
 * an LLM's context, so its length has to be bounded by us rather than by them.
 */
const MAX_REPORTED_ISSUES = 5;

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

// Asset identifiers are short lowercase slugs ('solana', 'usdc'). Bounding the
// charset and length keeps a malicious `payment-required` from smuggling prompt-
// injection text through `chain`/`token` into an "unknown asset" error that
// surfaces (unwrapped) to the customer's LLM.
const ASSET_ID_RE = /^[a-z0-9-]+$/;
const assetIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(ASSET_ID_RE, 'must be a lowercase asset id (a-z, 0-9, hyphen)');

const paymentAssetRefSchema = z.object({
  chain: assetIdSchema,
  token: assetIdSchema,
  mint: solanaAddressSchema.optional(),
  decimals: z.number().int().min(0).max(18),
});

/**
 * Wire-shape for a NIP-90 payment_request blob, as parsed via JSON.parse.
 *
 * Stricter than the loose TypeScript interface: rejects negative amounts,
 * floats, NaN/Infinity, mistyped recipient/reference, and any expiry
 * outside `[1, PAYMENT_LIMITS.MAX_TIMEOUT_SECS]`. The strategy applies semantic
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
  asset: paymentAssetRefSchema.optional(),
  // Optional on the parse side: requests from pre-mainnet providers carry no
  // network and are treated as devnet by `validatePaymentRequest`.
  network: z.enum(['devnet', 'mainnet']).optional(),
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
 * Describe why a payment request failed its schema, naming ONLY the field and a
 * fixed reason - never the value that was rejected.
 *
 * A payment request is written by a remote provider, and Zod's own message
 * quotes the rejected value back verbatim (`"received": "<whatever they sent>"`).
 * Callers put this message in front of an LLM: `send_payment` returns it as tool
 * output and `submit_and_pay_job` throws it. So the raw message is a direct
 * channel from a hostile provider into the customer's model - the same
 * boundary-bypass class already closed for provider error feedback and for the
 * payment request itself. Naming the field is enough to debug with; the value
 * adds nothing a caller needs and carries everything an attacker wants.
 */
export function describeIssues(issues: readonly { path: PropertyKey[]; code: string }[]): string {
  if (issues.length === 0) {
    return 'Payment request does not match the expected shape.';
  }
  const described = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${field}: ${issue.code}`;
  });
  const omitted = issues.length - described.length;
  const tail = omitted > 0 ? `, and ${omitted} more` : '';
  return `Payment request is invalid - ${described.join('; ')}${tail}.`;
}

/**
 * Parse a JSON-encoded payment request through the Zod schema, optionally
 * enforcing a `maxAmountLamports` ceiling supplied by the caller (e.g. the
 * customer's per-job spending cap).
 */
export function parsePaymentRequest(input: string, options?: ParseOptions): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // The parser error is NOT interpolated: it quotes the offending input, and a
    // payment request arrives from a remote provider. See `describeIssues`.
    return {
      ok: false,
      error: { code: 'invalid_json', message: 'Invalid payment request JSON.' },
    };
  }
  const result = PaymentRequestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: { code: 'schema', message: describeIssues(result.error.issues) },
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
