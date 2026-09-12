/**
 * Metered pricing descriptor - the per-skill declaration that a capability
 * charges what the job actually consumed rather than a flat fee.
 *
 * The load-bearing decision: the EXISTING `price` field keeps its meaning and
 * becomes the CEILING. A client that knows nothing about metering still reads
 * `payment.job_price`, still gates `max_price_lamports` on it, and is then
 * charged LESS - it can only be pleasantly surprised. Encoding it the other way
 * round (`price` = the floor plus a new `price_max`) would make every existing
 * client under-display the real cost, which is exactly the failure this design
 * exists to avoid.
 *
 * So this descriptor carries only the FLOOR. The runtime clamps whatever the
 * skill reports into `[min, price]`.
 *
 * Two shapes, mirroring {@link ../delegation/schema.ts}:
 * - {@link SkillMeteredSchema} - what an operator writes in SKILL.md
 *   frontmatter, in display units (same spelling as `price`).
 * - {@link MeteredDescriptorSchema} - what rides on the NIP-89 card, resolved to
 *   subunits so a reader never has to know the asset's decimals.
 *
 * Both use `.strip()` to match `parseCapabilityEvent`'s coerce-don't-drop
 * posture: a future field must never hide an otherwise valid agent from an
 * older client. The write side (SKILL.md loader) still fails loud on a
 * malformed value; the read side (card parse) clears a malformed descriptor to
 * `undefined` rather than dropping the whole card.
 */

import { z } from 'zod';

/**
 * Positive integer string in the asset's subunits (6-decimal USDC: "1000" =
 * 0.001 USDC). A string, not a number, so a large floor never loses precision
 * through a JS double - same reasoning as `suggested_cap_subunits`.
 */
const SUBUNITS_STRING_REGEX = /^\d{1,20}$/;

/**
 * u64 ceiling (SPL amounts are u64). The 20-digit regex admits values above it,
 * so bound it explicitly: the read side clears an over-u64 floor, the write side
 * rejects it.
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
 * SKILL.md frontmatter form. `min` is spelled in DISPLAY units, exactly like
 * `price`, because that is what an operator already writes and reads. The
 * loader resolves it to subunits with the same parser as `price` and enforces
 * `0 < min <= price` there - a rule this schema cannot see, because the price
 * and the asset are not in scope here.
 */
export const SkillMeteredSchema = z
  .object({
    min: z.union([z.number(), z.string()]),
  })
  .strip();

export type SkillMetered = z.infer<typeof SkillMeteredSchema>;

/**
 * Card form: the floor resolved to subunits by the publishing agent, so a
 * reader needs no knowledge of the asset's decimals to render "from X".
 */
export const MeteredDescriptorSchema = z
  .object({
    min_subunits: z
      .string()
      .regex(
        SUBUNITS_STRING_REGEX,
        'metered.min_subunits must be a non-negative integer string in subunits (e.g. "1000")',
      )
      // Belt and braces: on the card path the cross-field check below clears
      // anything above `job_price` (a JS number, so <= 2^53) long before u64
      // matters. Kept because this schema is exported and a direct caller has
      // no such ceiling.
      .refine(isWithinU64, 'metered.min_subunits must not exceed the u64 maximum'),
  })
  .strip();

export type MeteredDescriptor = z.infer<typeof MeteredDescriptorSchema>;

/**
 * Parse an untrusted card `metered` value. Returns the validated descriptor, or
 * `null` when absent or malformed. Read-side callers treat `null` as "no usable
 * metering" and CLEAR the field - they must not drop the whole card.
 *
 * `jobPriceSubunits` makes this more than a shape check: a floor above the
 * ceiling is incoherent (a client would render "from 0.05, up to 0.02"), so it
 * is cleared too. Pass `undefined` when the card carries no price - a metered
 * descriptor without a ceiling to clamp against is equally unusable.
 */
export function parseMeteredDescriptor(
  raw: unknown,
  jobPriceSubunits: number | undefined,
): MeteredDescriptor | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const result = MeteredDescriptorSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  // A card with no price has no ceiling to clamp against, so a metered
  // descriptor on it is unusable. (`parseCapabilityEvent` already drops a card
  // whose `job_price` is a non-integer before this runs, so only the absent
  // case is reachable from there - the integer check is for direct callers.)
  if (jobPriceSubunits === undefined || !Number.isInteger(jobPriceSubunits)) {
    return null;
  }
  const min = BigInt(result.data.min_subunits);
  // A zero floor would let the runtime clamp to zero, and `buildDelegatedTransfer`
  // rejects a non-positive amount - the job would die after the work was done.
  if (min <= 0n || min > BigInt(jobPriceSubunits)) {
    return null;
  }
  return result.data;
}

/**
 * Validate a SKILL.md `metered` frontmatter block. Fail-loud: throws with a
 * clear message so a hand-edited bad block is caught at load, not silently
 * dropped by every consumer. Returns `undefined` when absent (metering is
 * opt-in per skill). The cross-field rules (`0 < min <= price`, `dynamic-script`
 * only, `delegation` required) live in the loader, which can see those values.
 */
export function validateSkillMetered(skillName: string, raw: unknown): SkillMetered | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`SKILL.md "${skillName}": "metered" must be a mapping`);
  }
  const result = SkillMeteredSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`SKILL.md "${skillName}": invalid "metered" block: ${detail}`);
  }
  return result.data;
}
