import {
  DEFAULT_MAX_TOKENS,
  EFFORTS,
  type Effort,
  type LlmProvider,
  MAX_MODEL_CALLS_PER_TURN,
  type ModelPrice,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
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
  | { kind: 'openrouter'; apiKey: string; model: string; providers: string[] };

// cspell:disable
/**
 * OpenRouter hosts that serve from the US or the EU (spec 8: visitor data stays there). To add
 * one, check where it hosts on its OpenRouter provider page, then add its slug here.
 */
export const OPENROUTER_HOSTS: readonly string[] = [
  'together',
  'fireworks',
  'baseten',
  'deepinfra',
  'parasail',
  'crusoe',
  'coreweave',
  'modal',
  'digitalocean',
  'google-vertex',
  'amazon-bedrock',
  'azure',
  'anthropic',
  'openai',
  'google-ai-studio',
  'groq',
  'cerebras',
  'sambanova',
  'lambda',
  'nebius',
  'mistral',
  'venice',
];
/** China-hosted OpenRouter hosts: never, whatever the model. */
const CHINA_HOSTED: readonly string[] = [
  'deepseek',
  'siliconflow',
  'baidu',
  'alibaba',
  'streamlake',
  'atlas-cloud',
];
// cspell:enable
/** A slug, with an optional variant ("fireworks/us"). */
const HOST_SLUG_RE = /^([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/u;
/** Host variants that keep the host's region: quantized builds and service tiers. */
const HOST_VARIANTS: readonly string[] = [
  'fp4',
  'fp8',
  'fp16',
  'bf16',
  // cspell:disable-next-line
  'mxfp4',
  'int4',
  'int8',
  'flex',
  'spot',
  'fast',
  'priority',
  'turbo',
];
/** A US or EU region variant: us, eu, us-east-1, eu-west-1 ("global" could be anywhere). */
const REGION_VARIANT_RE = /^(?:us|eu)(?:-[a-z]+-\d+)?$/u;

/**
 * ASKR_OPENROUTER_PROVIDERS: the hosts an OpenRouter request may go to, comma-separated
 * ("together,fireworks"), required for every OpenRouter model, each one a listed US or EU host
 * (OPENROUTER_HOSTS), never a China-hosted one: OpenRouter is told to use only these, with no
 * fallback (spec 8).
 */
export function openRouterProvidersFrom(model: string, value: string | undefined): string[] {
  if (value === undefined) {
    throw new Error(
      `ASKR_OPENROUTER_PROVIDERS is required with ASKR_OPENROUTER_MODEL ${model}: name the hosts it may run on, comma-separated (for example together,fireworks,baseten,deepinfra).`,
    );
  }
  const providers = value.split(',').map((slug) => slug.trim().toLowerCase());
  if (providers.some((slug) => slug.length === 0)) {
    throw new Error(`ASKR_OPENROUTER_PROVIDERS has an empty entry: ${value}`);
  }
  for (const slug of providers) {
    const host = HOST_SLUG_RE.exec(slug)?.[1] ?? '';
    if (CHINA_HOSTED.includes(host)) {
      throw new Error(
        `ASKR_OPENROUTER_PROVIDERS must not name ${slug}: visitor data never goes to a China-hosted endpoint.`,
      );
    }
    const variant = HOST_SLUG_RE.exec(slug)?.[2];
    if (
      OPENROUTER_HOSTS.includes(host) &&
      variant !== undefined &&
      !HOST_VARIANTS.includes(variant) &&
      !REGION_VARIANT_RE.test(variant)
    ) {
      throw new Error(
        `ASKR_OPENROUTER_PROVIDERS names ${slug}: an unknown variant. Allowed: a US or EU region (us, eu, us-east-1...) or ${HOST_VARIANTS.join(', ')}.`,
      );
    }
    if (!OPENROUTER_HOSTS.includes(host)) {
      throw new Error(
        `ASKR_OPENROUTER_PROVIDERS names ${slug}, not a known US or EU host. Known: ${OPENROUTER_HOSTS.join(', ')} (a variant like fireworks/us is allowed). To add a host, check where it serves from and add it to OPENROUTER_HOSTS in packages/askr-server/src/config.ts.`,
      );
    }
  }
  return providers;
}

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
/** An empty variable is an unset one, as `required` reads it, everywhere. */
function withoutEmpty(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

export function serveConfigFromEnv(rawEnv: Env): ServeConfig {
  const env = withoutEmpty(rawEnv);
  const openRouterModel = env.ASKR_OPENROUTER_MODEL;
  let model: ModelConfig;
  if (openRouterModel) {
    if (env.ASKR_EFFORT !== undefined) {
      throw new Error(
        'ASKR_EFFORT is an Anthropic setting and is not passed to OpenRouter: unset it with ASKR_OPENROUTER_MODEL.',
      );
    }
    const providers = openRouterProvidersFrom(openRouterModel, env.ASKR_OPENROUTER_PROVIDERS);
    model = {
      kind: 'openrouter',
      apiKey: required(env, 'OPENROUTER_API_KEY'),
      model: openRouterModel,
      providers,
    };
  } else {
    if (env.ASKR_OPENROUTER_PROVIDERS !== undefined) {
      throw new Error(
        'ASKR_OPENROUTER_PROVIDERS is an OpenRouter setting: unset it without ASKR_OPENROUTER_MODEL.',
      );
    }
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

/** The provider for the configured model; `fetch` is for tests. */
export function providerFor(config: ModelConfig, fetch?: typeof globalThis.fetch): LlmProvider {
  if (config.kind === 'openrouter') {
    return createOpenAiCompatibleProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: 'https://openrouter.ai/api/v1',
      // Anthropic models through OpenRouter need the cache marks passed through (5.7).
      passCacheMarks: config.model.startsWith('anthropic/'),
      // No training and zero data retention where offered (4.4); only the named hosts, with no
      // fallback to others (spec 8).
      extraBody: {
        provider: { data_collection: 'deny', only: config.providers, allow_fallbacks: false },
      },
      ...(fetch ? { fetch } : {}),
    });
  }
  return createAnthropicProvider({
    apiKey: config.apiKey,
    model: config.model,
    ...(config.effort ? { effort: config.effort } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

/** The worker's model settings from the checked configuration. */
export function workerSettings(
  config: ServeConfig,
  fetch?: typeof globalThis.fetch,
): {
  providerFor: () => LlmProvider;
  price: ModelPrice;
  reserveUsd: string;
  maxTokens: number;
} {
  const provider = providerFor(config.model, fetch);
  return {
    providerFor: () => provider,
    price: config.price,
    reserveUsd: config.reserveUsd,
    maxTokens: config.maxTokens,
  };
}
