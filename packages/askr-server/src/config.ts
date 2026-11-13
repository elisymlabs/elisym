import { EFFORTS, type Effort } from '@elisym/askr-agent';
import Decimal from 'decimal.js-light';

/** Nine decimals at most: the database keeps USD as `numeric(20, 9)`. */
const USD_RE = /^\d{1,9}(\.\d{1,9})?$/;
/** One turn's reservation and spend ceiling unless the environment says otherwise (5.8). */
export const DEFAULT_TURN_RESERVE_USD = '0.25';

/** A USD amount from the environment: a plain decimal above zero, checked at start, not on the first ask. */
export function positiveUsd(name: string, value: string): string {
  if (!USD_RE.test(value) || new Decimal(value).lessThanOrEqualTo(0)) {
    throw new Error(`${name} must be a decimal above zero, got ${value}`);
  }
  return value;
}

/** The public base NIP-98 `u` is compared with (7.3), without a trailing slash. */
export function publicBaseOf(value: string): string {
  return value.replace(/\/+$/u, '');
}

/** A whole number above zero from the environment, checked at start. */
export function positiveInteger(name: string, value: string): number {
  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw new Error(`${name} must be a whole number above zero, got ${value}`);
  }
  return Number(value);
}

const MILLION = 1_000_000;

/**
 * The turn's spend reservation must pay for the most output a turn can
 * produce: every model call at its max_tokens (thinking included) at the
 * output price. Otherwise the ceiling (checked before each call) can be
 * passed by more than a reservation's worth. Throws, naming the numbers.
 */
export function checkTurnBudget(budget: {
  maxTokens: number;
  calls: number;
  outputPricePerMillion: string;
  reserveUsd: string;
}): void {
  const worst = new Decimal(budget.maxTokens)
    .times(budget.calls)
    .times(budget.outputPricePerMillion)
    .div(MILLION);
  if (worst.greaterThan(budget.reserveUsd)) {
    throw new Error(
      `A turn can spend up to ${worst.toFixed()} USD on output (${budget.calls} calls x ${budget.maxTokens} max tokens at ${budget.outputPricePerMillion} USD per million), more than ASKR_TURN_RESERVE_USD ${budget.reserveUsd}. Lower ASKR_MAX_TOKENS (with a lower ASKR_EFFORT so thinking fits) or raise ASKR_TURN_RESERVE_USD.`,
    );
  }
}

/**
 * ASKR_EFFORT for an Anthropic model, low when unset: Claude Haiku, Sonnet and
 * Opus 5.5 think by default and the thinking counts toward max_tokens, so a
 * low effort keeps a short answer within ASKR_MAX_TOKENS.
 */
export function effortFrom(value: string | undefined): Effort {
  const wanted = value ?? 'low';
  const effort = EFFORTS.find((level) => level === wanted);
  if (effort === undefined) {
    throw new Error(`ASKR_EFFORT must be one of ${EFFORTS.join(', ')}, got ${wanted}`);
  }
  return effort;
}
