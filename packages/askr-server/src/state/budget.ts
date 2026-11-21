import Decimal from 'decimal.js-light';
import type { Tier } from './types';

/**
 * The least spend ceiling a turn gets when its reservation was clipped to what is left of the
 * month's budget: a normal turn costs about 0.002 USD over a few model calls, so a ceiling of a
 * cent lets it finish instead of stopping after its first call. A clipped turn can pass the budget
 * by at most this plus its last model call, and only the last turns before the budget runs out
 * are clipped.
 */
export const MIN_TURN_CEILING_USD = '0.01';

/**
 * What one more turn reserves (5.8): `reserveUsd`, or only what is left of the month's budget
 * when that is less, so a plan's budget can be spent in full. Undefined when nothing is left: the
 * turn is refused with `budget`.
 */
export function turnReservation(reserveUsd: string, left: Decimal): Decimal | undefined {
  if (left.lessThanOrEqualTo(0)) {
    return undefined;
  }
  return left.lessThan(reserveUsd) ? left : new Decimal(reserveUsd);
}

/**
 * A turn's spend ceiling (the worker's capped provider): its reservation, but never less than
 * `MIN_TURN_CEILING_USD` (a clipped reservation would stop a normal turn after one call) and never
 * more than a full turn's reservation `reserveUsd`.
 */
export function turnCeiling(reservedUsd: string, reserveUsd: string): string {
  const floor = new Decimal(reserveUsd).lessThan(MIN_TURN_CEILING_USD)
    ? new Decimal(reserveUsd)
    : new Decimal(MIN_TURN_CEILING_USD);
  const reserved = new Decimal(reservedUsd);
  return (reserved.lessThan(floor) ? floor : reserved).toFixed();
}

/**
 * Whether the plan's monthly budget is reached, by the test a reservation makes (`PgState`):
 * nothing is left of it, reservations of turns in flight counted. False for a store with no tier
 * (it answers nothing anyway).
 */
export function budgetReached(
  usage: { today: { reserved: string }; month: { spent: string } },
  tier: Tier | undefined,
): boolean {
  if (tier === undefined) {
    return false;
  }
  // `month.spent` already counts today's spend; today's open reservations count as well.
  return new Decimal(usage.month.spent)
    .plus(usage.today.reserved)
    .greaterThanOrEqualTo(tier.monthlyBudgetUsd);
}

/**
 * A warning for a tier whose monthly budget is below one turn's reservation, naming it and the
 * numbers; undefined when it covers a full reservation. Such a tier still answers (its turns
 * reserve only what is left), but one turn in flight can then hold the whole budget, so the store
 * answers about one visitor at a time.
 */
export function reserveWarning(tier: Tier, reserveUsd: string): string | undefined {
  if (!new Decimal(tier.monthlyBudgetUsd).lessThan(reserveUsd)) {
    return undefined;
  }
  return `tier ${tier.name}: its monthly budget ${new Decimal(tier.monthlyBudgetUsd).toFixed()} USD is below one turn's reservation (ASKR_TURN_RESERVE_USD ${new Decimal(reserveUsd).toFixed()}): its turns reserve only what is left, so one turn in flight can hold the whole budget and the store answers about one visitor at a time. Raise the tier's monthly budget, or lower ASKR_TURN_RESERVE_USD (and ASKR_MAX_TOKENS so a turn still fits it).`;
}
