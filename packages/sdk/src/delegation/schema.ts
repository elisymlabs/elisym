/**
 * Delegation descriptor - the per-skill declaration an agent publishes on its
 * NIP-89 capability card announcing that it accepts an SPL-approve bounded
 * allowance (v1: `spl-approve` only).
 *
 * Two shapes:
 * - {@link SkillDelegationSchema} - what an operator writes in SKILL.md
 *   frontmatter. It has NO `delegate_pubkey`: that is derived from the agent's
 *   dedicated delegate key at `buildCard` time, never hand-typed.
 * - {@link DelegationDescriptorSchema} - the full descriptor as it rides on the
 *   card (frontmatter fields + the injected `delegate_pubkey`).
 *
 * Both use `.strip()` (drop unknown keys, keep known ones) to match
 * `parseCapabilityEvent`'s coerce-don't-drop, forward-compatible posture: a
 * future descriptor field must never hide an otherwise valid agent from an
 * older client. The write side (SKILL.md loader) still fails loud on a
 * malformed value - an operator's own file should not silently ship a broken
 * descriptor - while the read side (card parse) clears a malformed descriptor
 * to `undefined` rather than dropping the whole card.
 */

import { z } from 'zod';

/** The only delegation mechanism in v1. */
export const DELEGATION_MECHANISM = 'spl-approve' as const;

/** base58 Solana address (32-44 chars, excludes 0 O I l). Mirrors discovery's. */
const DELEGATE_PUBKEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Non-negative integer string in the delegated asset's subunits (e.g. 6-decimal
 * USDC: "50000000" = 50 USDC). A string, not a number, so a large cap never
 * loses precision through a JS double. `expires_at` is advisory only - SPL
 * `approve` has no on-chain expiry - so it is rendered as a client-side revoke
 * reminder, never enforced.
 */
const SUBUNITS_STRING_REGEX = /^\d{1,20}$/;

/**
 * u64 ceiling (SPL amounts are u64). The 20-digit regex admits values above
 * this, so an untrusted card could otherwise carry a `suggested_cap_subunits`
 * that renders as a nonsensical huge amount. It is display-only (the real cap
 * is owner-typed and `assertU64`-gated at approve time), but bounding it here
 * keeps the descriptor honest: the read side clears an over-u64 value, the
 * write side rejects it.
 */
const U64_MAX = (1n << 64n) - 1n;

function isWithinU64(value: string): boolean {
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

/**
 * SKILL.md frontmatter form: what an operator declares. `delegate_pubkey` is
 * intentionally absent - it is filled from the agent's dedicated delegate key
 * at publish time.
 */
export const SkillDelegationSchema = z
  .object({
    mechanism: z.literal(DELEGATION_MECHANISM),
    suggested_cap_subunits: z
      .string()
      .regex(
        SUBUNITS_STRING_REGEX,
        'delegation.suggested_cap_subunits must be a non-negative integer string in subunits (e.g. "50000000")',
      )
      .refine(isWithinU64, 'delegation.suggested_cap_subunits must not exceed the u64 maximum'),
    expires_at: z.number().int().nonnegative().nullish(),
  })
  .strip();

export type SkillDelegation = z.infer<typeof SkillDelegationSchema>;

/**
 * Full descriptor as published on the capability card: the frontmatter fields
 * plus the `delegate_pubkey` derived from the agent's delegate key.
 */
export const DelegationDescriptorSchema = SkillDelegationSchema.extend({
  delegate_pubkey: z
    .string()
    .regex(DELEGATE_PUBKEY_REGEX, 'delegation.delegate_pubkey must be a base58 Solana address'),
}).strip();

export type DelegationDescriptor = z.infer<typeof DelegationDescriptorSchema>;

/**
 * Parse an untrusted card `delegation` value. Returns the validated descriptor,
 * or `null` when absent or malformed. Callers on the read side (card parse)
 * treat `null` as "no usable delegation" and clear the field - they must NOT
 * drop the whole card, matching the `inputText`/`context`/`image` coercions.
 */
export function parseDelegationDescriptor(raw: unknown): DelegationDescriptor | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const result = DelegationDescriptorSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Validate a SKILL.md `delegation` frontmatter block. Fail-loud: throws with a
 * clear message so a hand-edited bad descriptor is caught at load/publish, not
 * silently dropped by every consumer. Returns `undefined` when the block is
 * absent (delegation is opt-in per skill).
 */
export function validateSkillDelegation(
  skillName: string,
  raw: unknown,
): SkillDelegation | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`SKILL.md "${skillName}": "delegation" must be a mapping`);
  }
  const result = SkillDelegationSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`SKILL.md "${skillName}": invalid "delegation" block: ${detail}`);
  }
  return result.data;
}
