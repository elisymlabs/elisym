/**
 * Metered pricing: the capability charges what the job actually consumed,
 * clamped into `[metered.min, price]`.
 *
 * `price` keeps its existing meaning and is the CEILING, so a client that knows
 * nothing about metering still displays and gates on a number it will never be
 * charged above. See `schema.ts` for why the floor - not the ceiling - is the
 * new field.
 */

export {
  MeteredDescriptorSchema,
  SkillMeteredSchema,
  parseMeteredDescriptor,
  validateSkillMetered,
} from './schema';
export type { MeteredDescriptor, SkillMetered } from './schema';
