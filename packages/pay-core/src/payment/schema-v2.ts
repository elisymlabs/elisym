/**
 * Payment request v2 - the wire shape for a payment on an EVM chain.
 *
 * It is a SEPARATE schema, not a wider v1: v1 stays byte-for-byte what every
 * released client parses, and `parseAnyPaymentRequest` is the only place that
 * decides which of the two a blob is. Nothing here defaults: a field that is
 * absent is a refusal, because every implicit default of v1 (no asset = SOL,
 * no network = devnet) names Solana.
 *
 * Mapping to an MPP `tempo` charge (D10): `amount` = `amount`; the address in
 * `asset` = `currency`; `recipient` = `recipient`; `chain` =
 * `methodDetails.chainId`; `memo` = `methodDetails.memo`; the fee leg
 * (`fee_address`, `fee_amount`) = `methodDetails.splits[0]`.
 *
 * `amount` is the TOTAL the customer pays; with a fee leg the provider receives
 * `amount - fee_amount`, as in v1. `memo` is 32 random bytes the provider picks
 * per request - the twin of the Solana reference key.
 */

import { z } from 'zod';
import { assetKey, assetsFor } from './assets';
import type { Asset } from './assets';
import { chainByCaip2, isEvmWireAddress, isVirtualEvmAddress } from './chains';
import { describeIssues, parsePaymentRequest } from './schema';
import type { ParseError, ParsedPaymentRequest } from './schema';

const MAX_EXPIRY_SECS_SCHEMA = 86_400;
/** uint256 has 78 digits; no stablecoin amount needs more than 30, and a bound keeps BigInt cheap. */
const MAX_AMOUNT_DIGITS = 30;
const CANONICAL_UINT_RE = /^(0|[1-9][0-9]*)$/;
const MEMO_WIRE_RE = /^0x[0-9a-f]{64}$/;
const CAIP2_EVM_RE = /^eip155:[1-9][0-9]{0,17}$/;
const CAIP19_ERC20_RE = /^(eip155:[1-9][0-9]{0,17})\/erc20:(0x[0-9a-f]{40})$/;

function isCanonicalUint(value: string): boolean {
  return value.length <= MAX_AMOUNT_DIGITS && CANONICAL_UINT_RE.test(value);
}

const subunitsSchema = z
  .string()
  .max(MAX_AMOUNT_DIGITS)
  .regex(CANONICAL_UINT_RE, 'must be a canonical non-negative integer string');

const evmAddressSchema = z
  .string()
  .refine(isEvmWireAddress, 'must be a lowercase 0x address')
  .refine((address) => !isVirtualEvmAddress(address), 'virtual addresses are not accepted');

export const PaymentRequestV2Schema = z
  .object({
    v: z.literal(2),
    chain: z
      .string()
      .regex(CAIP2_EVM_RE, 'must be an eip155 CAIP-2 id')
      .refine((caip2) => chainByCaip2(caip2)?.family === 'evm', 'not a chain this SDK knows'),
    asset: z.string().regex(CAIP19_ERC20_RE, 'must be a CAIP-19 erc20 id'),
    recipient: evmAddressSchema,
    amount: subunitsSchema,
    fee_address: evmAddressSchema.optional(),
    fee_amount: subunitsSchema.optional(),
    memo: z.string().regex(MEMO_WIRE_RE, 'must be 32 bytes of lowercase hex'),
    created_at: z.number().int().positive(),
    expiry_secs: z
      .number()
      .int()
      .positive()
      .max(MAX_EXPIRY_SECS_SCHEMA, `expiry_secs must be <= ${MAX_EXPIRY_SECS_SCHEMA}`),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.asset.startsWith(`${request.chain}/`)) {
      context.addIssue({ code: 'custom', path: ['asset'], message: 'asset is on another chain' });
    }
    // Zod 3 runs an object refinement even when a FIELD already failed (the
    // status is "dirty", not "aborted"), and `BigInt` throws on a non-number.
    // The field issue is already recorded; there is nothing to compare.
    if (!isCanonicalUint(request.amount)) {
      return;
    }
    const amount = BigInt(request.amount);
    if (amount <= 0n) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'amount must be positive' });
    }
    const hasFeeAddress = request.fee_address !== undefined;
    const hasFeeAmount = request.fee_amount !== undefined;
    if (hasFeeAddress !== hasFeeAmount) {
      context.addIssue({
        code: 'custom',
        path: [hasFeeAddress ? 'fee_amount' : 'fee_address'],
        message: 'fee_address and fee_amount come together or not at all',
      });
      return;
    }
    if (
      request.fee_address === undefined ||
      request.fee_amount === undefined ||
      !isCanonicalUint(request.fee_amount)
    ) {
      return;
    }
    const feeAmount = BigInt(request.fee_amount);
    // A zero fee is written by OMITTING both fields: one way to say "no fee".
    if (feeAmount <= 0n) {
      context.addIssue({
        code: 'custom',
        path: ['fee_amount'],
        message: 'fee_amount must be positive; omit both fee fields at fee 0',
      });
    }
    if (amount - feeAmount <= 0n) {
      context.addIssue({
        code: 'custom',
        path: ['fee_amount'],
        message: 'fee_amount must be smaller than amount',
      });
    }
    if (request.fee_address === request.recipient) {
      context.addIssue({
        code: 'custom',
        path: ['fee_address'],
        message: 'fee_address must differ from recipient',
      });
    }
  });

export type ParsedPaymentRequestV2 = z.infer<typeof PaymentRequestV2Schema>;

/**
 * The registry asset a v2 request names, or `undefined` when the SDK does not
 * know the contract. The address and decimals of a coin come from the registry
 * ONLY - a consumer that gets `undefined` shows no amount at all, never SOL.
 */
export function resolveAssetFromPaymentRequestV2(
  request: Pick<ParsedPaymentRequestV2, 'chain' | 'asset'>,
): Asset | undefined {
  const chain = chainByCaip2(request.chain);
  const match = CAIP19_ERC20_RE.exec(request.asset);
  if (!chain || !match || match[1] !== request.chain) {
    return undefined;
  }
  const contract = match[2];
  // Through the chain's ENVIRONMENT: the USDC.e contract named on Moderato is not
  // a coin there, whatever symbol mainnet gives that address.
  return assetsFor(chain.slug, chain.network).find((asset) => asset.mint === contract);
}

/** The CAIP-19 id a v2 request carries for a registry asset on a registry chain. */
export function caip19ForAsset(caip2: string, asset: Asset): string {
  const chain = chainByCaip2(caip2);
  // Only a coin the registry holds for THAT chain and environment: USDC.e named
  // on Moderato, or a Tempo coin under a Solana id, would build an id every
  // reader refuses. Matched by KEY, never by identity: each SDK entry point is
  // bundled with its own copy of the registry, so an asset that came through
  // `@elisym/sdk/skills` is not `===` the root entry's constant.
  const coin =
    chain?.family === 'evm'
      ? assetsFor(chain.slug, chain.network).find((known) => assetKey(known) === assetKey(asset))
      : undefined;
  if (!coin?.mint) {
    throw new Error(`Asset ${asset.token} is not a coin of ${caip2}`);
  }
  return `${caip2}/erc20:${coin.mint}`;
}

export interface ParseAnyOptions {
  /** Refuse a request whose total amount, in subunits, exceeds this. Applies to BOTH versions. */
  maxAmountSubunits?: bigint;
}

export type AnyParseError = ParseError | { code: 'unsupported_version'; message: string };

/**
 * A refusal still says which version the blob CLAIMED to be, when that could be
 * told: a consumer that shows amounts must not fall back to "no asset means
 * lamports" for a v2 blob it failed to parse.
 */
export type AnyParseResult =
  | { ok: true; version: 1; data: ParsedPaymentRequest }
  | { ok: true; version: 2; data: ParsedPaymentRequestV2 }
  | { ok: false; version: 1 | 2 | undefined; error: AnyParseError };

/**
 * The one place that decides which version a payment request is. No `v` key:
 * the existing v1 parser, untouched. `v` equal to the NUMBER 2: the v2 schema.
 * Any other `v` - `"2"`, `3`, `null` - is refused; it is never read as v1, whose
 * every default names Solana.
 */
export function parseAnyPaymentRequest(input: string, options?: ParseAnyOptions): AnyParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // The parser error is NOT interpolated: it quotes provider-written input.
    return {
      ok: false,
      version: undefined,
      error: { code: 'invalid_json', message: 'Invalid payment request JSON.' },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || !('v' in parsed)) {
    const v1 = parsePaymentRequest(input, { maxAmountLamports: options?.maxAmountSubunits });
    return v1.ok
      ? { ok: true, version: 1, data: v1.data }
      : { ok: false, version: 1, error: v1.error };
  }
  if (parsed.v !== 2) {
    return {
      ok: false,
      version: undefined,
      error: {
        code: 'unsupported_version',
        message: 'Payment request version is not supported by this client.',
      },
    };
  }
  const result = PaymentRequestV2Schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      version: 2,
      error: { code: 'schema', message: describeIssues(result.error.issues) },
    };
  }
  if (
    options?.maxAmountSubunits !== undefined &&
    BigInt(result.data.amount) > options.maxAmountSubunits
  ) {
    return {
      ok: false,
      version: 2,
      error: {
        code: 'amount_exceeds_max',
        message: `Payment amount ${result.data.amount} subunits exceeds approved max ${options.maxAmountSubunits}.`,
      },
    };
  }
  return { ok: true, version: 2, data: result.data };
}
