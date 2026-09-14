/**
 * Shapes for on-chain action capabilities: what an operator declares, what
 * rides on the capability card, and what a job hands back for signing.
 *
 * Three schemas, two audiences:
 * - {@link SkillOnchainSchema} - the `onchain:` block an operator writes in
 *   SKILL.md. Amounts are display units (`"500"` USDC), because that is what a
 *   human types; the loader converts them to subunits against the resolved
 *   asset. It carries no `network`: that is stamped from the agent's wallet at
 *   `buildCard` time, so a skill copied between a devnet and a mainnet agent
 *   cannot lie about where it runs.
 * - {@link OnchainDescriptorSchema} - the same declaration as published on the
 *   card: subunits, decimals and network resolved.
 * - {@link OnchainCallEnvelopeSchema} - what a job returns: one unsigned
 *   base64 transaction plus the metadata the client needs to bind it.
 *
 * Read/write posture matches `delegation/schema.ts`. Both card-facing schemas
 * `.strip()` unknown keys so a future field never hides an otherwise valid
 * agent from an older client; the read side CLEARS a malformed descriptor
 * rather than dropping the card, while the write side (loader, publish) fails
 * loud - an operator's own file should not silently ship a broken promise.
 *
 * Nothing here decides whether a call is safe. That is the verifier's job and
 * it runs on the client, against these shapes. See
 * `docs/plans/onchain-action-skills.md`.
 */

import Decimal from 'decimal.js-light';
import { z } from 'zod';
import {
  MAX_CALL_BASE64_CHARS,
  MAX_EXPLAIN_ENTRIES,
  MAX_EXPLAIN_TEXT_CHARS,
  MAX_EXPIRY_UNIX,
  MAX_KIND_CHARS,
  MAX_PARAM_DESCRIPTION_CHARS,
  MAX_PARAM_NAME_CHARS,
  MAX_PARAM_TYPE_CHARS,
  MAX_PARAMS_PER_CARD,
  MAX_PROGRAMS_PER_CARD,
  MAX_REQUIRES_PER_CARD,
  ONCHAIN_CALL_VERSION,
} from './constants';

/** base58 Solana material (32-44 chars, excludes 0 O I l). Mirrors discovery's. */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Lowercase token id, same alphabet the payment card field accepts. */
const TOKEN_ID_REGEX = /^[a-z0-9$._-]{1,32}$/;

/**
 * Display symbol. Deliberately narrow: this string is provider-controlled and
 * reaches an LLM's tool output, so newlines and markup have no business in it.
 */
const SYMBOL_REGEX = /^[A-Za-z0-9$._+-]{1,32}$/;

/** Label alphabet for `kind`, `requires` and parameter names. */
const LABEL_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/** Non-negative integer string in the action asset's subunits. */
const SUBUNITS_STRING_REGEX = /^\d{1,20}$/;

/** Non-negative decimal a human types in SKILL.md ("500", "0.25", "0"). */
const DISPLAY_AMOUNT_REGEX = /^\d{1,20}(?:\.\d{1,18})?$/;

/** Base64 with optional padding - decoded and length-checked later, never here. */
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const U64_MAX = (1n << 64n) - 1n;

export function isWithinU64(value: string): boolean {
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

/**
 * One input the capability takes. `type` is a bounded string rather than an
 * enum on the read side: an older client meeting a future type renders it as
 * text instead of losing the whole descriptor. The loader is where the known
 * set is enforced, on the operator's own file.
 */
const OnchainParamSchema = z
  .object({
    name: z.string().regex(LABEL_REGEX).max(MAX_PARAM_NAME_CHARS),
    type: z.string().min(1).max(MAX_PARAM_TYPE_CHARS),
    required: z.boolean().default(false),
    description: z.string().max(MAX_PARAM_DESCRIPTION_CHARS).optional(),
  })
  .strip();

export type OnchainParam = z.infer<typeof OnchainParamSchema>;

/** Fields that read the same in the operator's file and on the card. */
const commonShape = {
  /** Free-form grouping label ("withdraw", "swap", "approve"). Display only. */
  kind: z.string().regex(LABEL_REGEX).max(MAX_KIND_CHARS),
  /**
   * The COMPLETE set of programs this capability may ever touch. A call
   * reaching a program outside it is refused by the client before it is
   * rendered, which is what makes the card a promise rather than a hint.
   */
  programs: z.array(z.string().regex(SOLANA_ADDRESS_REGEX)).min(1).max(MAX_PROGRAMS_PER_CARD),
  /**
   * Display hint for clients ("this usually needs an approve first"). Never
   * enforced: the prerequisite is on-chain state, which the client can read.
   */
  requires: z.array(z.string().regex(LABEL_REGEX).max(MAX_KIND_CHARS)).max(MAX_REQUIRES_PER_CARD),
  params: z.array(OnchainParamSchema).max(MAX_PARAMS_PER_CARD),
};

/**
 * The `onchain:` block as written in SKILL.md frontmatter.
 *
 * `max_per_call` is the spend ceiling in display units and MAY be `"0"` - a
 * capability that only calls a program without moving value (claiming rewards,
 * closing a position into the same account) is legitimate, and a zero ceiling
 * states exactly that. For a SOL-denominated capability, note that rent for any
 * account the call creates is SOL leaving the customer and is bounded by this
 * ceiling too, so `"0"` there means "creates nothing, moves nothing".
 *
 * `grants_authority` and `max_authority` are the second,
 * separate bound: value the customer authorizes someone else to move LATER (an
 * SPL approve). They move in lockstep - an authority ceiling without the flag
 * would never be checked, and the flag without a ceiling would authorize
 * nothing while lifting the client's blanket refusal of new delegates.
 */
export const SkillOnchainSchema = z
  .object({
    ...commonShape,
    requires: commonShape.requires.default([]),
    params: commonShape.params.default([]),
    /** Lowercase asset id the ceilings are denominated in ('sol', 'usdc', 'lsm'). */
    token: z.string().regex(TOKEN_ID_REGEX),
    /** Explicit SPL mint. Normally omitted - the loader resolves it per network. */
    mint: z.string().regex(SOLANA_ADDRESS_REGEX).optional(),
    max_per_call: z.string().regex(DISPLAY_AMOUNT_REGEX),
    grants_authority: z.boolean().default(false),
    max_authority: z.string().regex(DISPLAY_AMOUNT_REGEX).default('0'),
  })
  .strip()
  .superRefine((value, ctx) => {
    const authorizesSomething = new Decimal(value.max_authority).gt(0);
    if (value.grants_authority && !authorizesSomething) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'onchain.max_authority must be positive when onchain.grants_authority is true',
      });
    }
    if (!value.grants_authority && authorizesSomething) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'onchain.max_authority must be "0" unless onchain.grants_authority is true',
      });
    }
    // Mirrors the card rule: an approval is always over an SPL mint, and a
    // native SOL capability has none, so the promise could never be kept.
    // Not gated on `mint`: the loader resolves `token: 'sol'` to native SOL and
    // discards whatever mint was written, so a block carrying one would
    // otherwise slip past here and fail later as an unreadable card.
    if (value.token === 'sol' && value.grants_authority) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'onchain.grants_authority cannot be set on a native SOL capability - an approval is ' +
          'always over an SPL mint, so price the ceiling in a token the agent resolves (usdc, lsm)',
      });
    }
    // The descriptor schema already forbids this pairing, but the loader
    // resolves `token: 'sol'` to native SOL and DISCARDS the mint before a
    // descriptor is ever built, so that rule never fires and the mistake is
    // silent. It is also expensive: a block written as 500 USDC publishes a
    // ceiling of 500 SOL, because the number is re-denominated at 9 decimals
    // rather than 6. Refused here, where the operator can still see it - the
    // same posture as the LSM price fallback, which a bound may not take.
    if (value.token === 'sol' && value.mint !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'onchain.mint must be absent when onchain.token is sol - a mint alongside it reads as ' +
          'a ceiling priced in that token but publishes one priced in SOL',
      });
    }
  });

export type SkillOnchain = z.infer<typeof SkillOnchainSchema>;

/**
 * The descriptor as published on the capability card: the operator's block
 * with the network stamped and both ceilings resolved to integer subunits.
 *
 * `decimals` is display metadata only - every ceiling comparison in the
 * verifier happens in subunits, which is the unit simulation deltas arrive in -
 * so a wrong value shifts a rendered decimal point and can never widen a bound.
 */
export const OnchainDescriptorSchema = z
  .object({
    ...commonShape,
    requires: commonShape.requires.default([]),
    params: commonShape.params.default([]),
    network: z.enum(['devnet', 'mainnet']),
    token: z.string().regex(TOKEN_ID_REGEX),
    mint: z.string().regex(SOLANA_ADDRESS_REGEX).optional(),
    decimals: z.number().int().min(0).max(18),
    symbol: z.string().regex(SYMBOL_REGEX).optional(),
    max_per_call_subunits: z.string().regex(SUBUNITS_STRING_REGEX).refine(isWithinU64),
    grants_authority: z.boolean().default(false),
    max_authority_subunits: z.string().regex(SUBUNITS_STRING_REGEX).refine(isWithinU64),
  })
  .strip()
  .superRefine((value, ctx) => {
    const authorizesSomething = BigInt(value.max_authority_subunits) > 0n;
    if (value.grants_authority !== authorizesSomething) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'onchain.grants_authority and a positive onchain.max_authority_subunits must agree',
      });
    }
    // The verifier matches simulated balance deltas by mint, so a non-native
    // asset without one cannot be bounded at all - every outflow would read as
    // "some other asset" and the capability would be unusable rather than
    // permissive. Native SOL is the only asset identified without a mint.
    if (value.token !== 'sol' && value.mint === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'onchain.mint is required for a capability priced in anything but native SOL',
      });
    }
    if (value.token === 'sol' && value.mint !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'onchain.mint must be absent when the asset is native SOL',
      });
    }
    // Every approval a call can leave is an SPL delegate, which carries a mint;
    // the verifier refuses one whose mint is not the card's, and a native card
    // has none. Such a promise could therefore never be kept - a customer would
    // be shown an authority ceiling that refuses every call it describes.
    if (value.token === 'sol' && value.mint === undefined && value.grants_authority) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'onchain.grants_authority cannot be set on a native SOL capability - an approval is ' +
          'always over an SPL mint, so price the ceiling in a token the agent resolves (usdc, lsm)',
      });
    }
  });

export type OnchainDescriptor = z.infer<typeof OnchainDescriptorSchema>;

/**
 * One line of provider-supplied explanation. UNTRUSTED: shown beside what the
 * client itself decoded and simulated, never instead of it and never alone.
 */
const OnchainExplainSchema = z
  .object({
    kind: z.string().max(MAX_EXPLAIN_TEXT_CHARS),
    asset: z.string().max(MAX_EXPLAIN_TEXT_CHARS).optional(),
    amount: z.string().max(MAX_EXPLAIN_TEXT_CHARS).optional(),
    to: z.string().max(MAX_EXPLAIN_TEXT_CHARS).optional(),
    note: z.string().max(MAX_EXPLAIN_TEXT_CHARS).optional(),
  })
  .strip();

export type OnchainExplain = z.infer<typeof OnchainExplainSchema>;

/**
 * What a job returns: exactly one unsigned transaction, plus the metadata the
 * client binds it with.
 *
 * One wire form on purpose. Every Solana API already produces a base64
 * transaction, decompiling it yields the instruction list anyway, and a second
 * accepted form would be a second parser to keep honest.
 *
 * The client owns the lifetime: it decompiles, sets a fresh blockhash, appends
 * its own budget instructions and recompiles. `expires_at` therefore bounds the
 * ENVELOPE's usefulness, not the transaction's - it is how long the provider
 * claims the built call still matches live state.
 */
export const OnchainCallEnvelopeSchema = z
  .object({
    elisym_call: z.literal(ONCHAIN_CALL_VERSION),
    network: z.enum(['devnet', 'mainnet']),
    transaction: z.string().min(1).max(MAX_CALL_BASE64_CHARS).regex(BASE64_REGEX),
    /** The customer pubkey this call was built for. A call for anyone else is refused. */
    signer: z.string().regex(SOLANA_ADDRESS_REGEX),
    expires_at: z.number().int().positive().max(MAX_EXPIRY_UNIX),
    explain: z.array(OnchainExplainSchema).max(MAX_EXPLAIN_ENTRIES).optional(),
  })
  .strip();

export type OnchainCallEnvelope = z.infer<typeof OnchainCallEnvelopeSchema>;

/**
 * Parse an untrusted card `onchain` value. Returns the validated descriptor or
 * `null` when absent or malformed. The read side treats `null` as "no usable
 * on-chain descriptor" and CLEARS the field - it must not drop the whole card,
 * matching the `delegation` / `inputText` / `context` coercions.
 */
export function parseOnchainDescriptor(raw: unknown): OnchainDescriptor | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const result = OnchainDescriptorSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Parse an untrusted job result into a call envelope. Accepts the JSON text a
 * skill returns or an already-parsed object. Returns `null` on anything
 * malformed; the verifier maps that to its own typed refusal reason so both
 * clients print the same words.
 */
export function parseOnchainCallEnvelope(raw: unknown): OnchainCallEnvelope | null {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (candidate === undefined || candidate === null) {
    return null;
  }
  const result = OnchainCallEnvelopeSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Validate a SKILL.md `onchain` frontmatter block. Fail-loud: throws with a
 * clear message so a hand-edited bad block is caught at load, not silently
 * dropped by every consumer. Returns `undefined` when the block is absent
 * (on-chain actions are opt-in per skill).
 */
export function validateSkillOnchain(skillName: string, raw: unknown): SkillOnchain | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`SKILL.md "${skillName}": "onchain" must be a mapping`);
  }
  const result = SkillOnchainSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`SKILL.md "${skillName}": invalid "onchain" block: ${detail}`);
  }
  return result.data;
}
