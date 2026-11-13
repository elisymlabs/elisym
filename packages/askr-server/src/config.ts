import {
  DEFAULT_MAX_TOKENS,
  EFFORTS,
  type Effort,
  MAX_MODEL_CALLS_PER_TURN,
  type ModelPrice,
} from '@elisym/askr-agent';
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
 * An output-only sanity check at start: the reservation should pay for the
 * most output a turn can produce, every model call at its max_tokens
 * (thinking included) at the output price. It leaves input out; the real
 * bound is the worker's capped provider, which starts no call once a turn has
 * spent its reservation, so a turn passes it by at most its last call.
 * Throws, naming the numbers.
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
 * low effort keeps a short answer within ASKR_MAX_TOKENS. `none` sends no
 * effort, for models without the parameter (claude-haiku-4-5, claude-sonnet-4-5),
 * which reject it.
 */
export function effortFrom(value: string | undefined): Effort | undefined {
  const wanted = value ?? 'low';
  if (wanted === 'none') {
    return undefined;
  }
  const effort = EFFORTS.find((level) => level === wanted);
  if (effort === undefined) {
    throw new Error(`ASKR_EFFORT must be one of ${EFFORTS.join(', ')} or none, got ${wanted}`);
  }
  return effort;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

export type ModelConfig =
  | { kind: 'anthropic'; apiKey: string; model: string; effort?: Effort }
  | { kind: 'openrouter'; apiKey: string; model: string };

export interface ServeConfig {
  model: ModelConfig;
  price: ModelPrice;
  reserveUsd: string;
  maxTokens: number;
}

/**
 * The model, price and turn budget from the environment, checked before the
 * server starts: an effort set for OpenRouter (which this server does not
 * pass through) and a max_tokens the reservation cannot pay for both refuse.
 */
export function serveConfigFromEnv(env: Env): ServeConfig {
  const openRouterModel = env.ASKR_OPENROUTER_MODEL;
  let model: ModelConfig;
  if (openRouterModel) {
    if (env.ASKR_EFFORT !== undefined) {
      throw new Error(
        'ASKR_EFFORT is an Anthropic setting and is not passed to OpenRouter: unset it with ASKR_OPENROUTER_MODEL.',
      );
    }
    model = {
      kind: 'openrouter',
      apiKey: required(env, 'OPENROUTER_API_KEY'),
      model: openRouterModel,
    };
  } else {
    const effort = effortFrom(env.ASKR_EFFORT);
    model = {
      kind: 'anthropic',
      apiKey: required(env, 'ANTHROPIC_API_KEY'),
      model: required(env, 'ASKR_MODEL'),
      ...(effort === undefined ? {} : { effort }),
    };
  }
  const price: ModelPrice = {
    input: positiveUsd('ASKR_PRICE_INPUT', required(env, 'ASKR_PRICE_INPUT')),
    cachedInput: positiveUsd('ASKR_PRICE_CACHED_INPUT', required(env, 'ASKR_PRICE_CACHED_INPUT')),
    cacheWrite: positiveUsd('ASKR_PRICE_CACHE_WRITE', required(env, 'ASKR_PRICE_CACHE_WRITE')),
    output: positiveUsd('ASKR_PRICE_OUTPUT', required(env, 'ASKR_PRICE_OUTPUT')),
  };
  const reserveUsd = positiveUsd(
    'ASKR_TURN_RESERVE_USD',
    env.ASKR_TURN_RESERVE_USD ?? DEFAULT_TURN_RESERVE_USD,
  );
  const maxTokens = positiveInteger(
    'ASKR_MAX_TOKENS',
    env.ASKR_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS),
  );
  checkTurnBudget({
    maxTokens,
    calls: MAX_MODEL_CALLS_PER_TURN,
    outputPricePerMillion: price.output,
    reserveUsd,
  });
  return { model, price, reserveUsd, maxTokens };
}
