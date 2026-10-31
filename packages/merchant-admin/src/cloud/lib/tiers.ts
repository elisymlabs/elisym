/**
 * The tier catalog as cloud-api serves it (`GET /tiers`): names, prices and
 * limits are data the console reads, never ids it knows (plan
 * `cloud-pricing-and-onboarding.md` 2.1).
 */
import { fieldOf } from './fields';

/** The tier a `/start` link names, if the catalog has it and a merchant may start it. */
export interface StartTier {
  name: string;
  price: string;
}

/** The self-serve tier `id` from a `GET /tiers` body; undefined when it is not one (or the body is not a catalog). */
export function startTierFrom(body: unknown, id: string): StartTier | undefined {
  const tiers = fieldOf(body, 'tiers');
  if (!Array.isArray(tiers)) {
    return undefined;
  }
  const tier: unknown = tiers.find((each: unknown) => fieldOf(each, 'id') === id);
  const name = fieldOf(tier, 'name');
  const price = fieldOf(tier, 'price');
  if (
    fieldOf(tier, 'selfServe') !== true ||
    typeof name !== 'string' ||
    typeof price !== 'string'
  ) {
    return undefined;
  }
  return { name, price };
}
