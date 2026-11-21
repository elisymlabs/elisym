import {
  DEFAULT_MAX_TOKENS,
  EFFORTS,
  type Effort,
  LlmError,
  type LlmProvider,
  MAX_MODEL_CALLS_PER_TURN,
  type ModelPrice,
  createAnthropicProvider,
  createCascadeProvider,
  createOpenAiCompatibleProvider,
} from '@elisym/askr-agent';
import Decimal from 'decimal.js-light';

/** Nine decimals at most: the database keeps USD as `numeric(20, 9)`. */
const USD_RE = /^\d{1,9}(\.\d{1,9})?$/;
/** One turn's reservation and spend ceiling unless the environment says otherwise (5.8). */
export const DEFAULT_TURN_RESERVE_USD = '0.25';
/**
 * Asks per visitor IPv4 address (or IPv6 /56) per UTC day across every session and store unless
 * ASKR_MESSAGES_PER_IP_PER_DAY says otherwise: a visitor can open new sessions, so the
 * per-session limit alone does not bound one person.
 */
export const DEFAULT_MESSAGES_PER_IP_PER_DAY = 100;

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

/** A model the cascade falls to when the ones before it fail: its hosts and its own price. */
export interface OpenRouterFallback {
  model: string;
  providers: string[];
  price: ModelPrice;
}

export type ModelConfig =
  | { kind: 'anthropic'; apiKey: string; model: string; effort?: Effort }
  | {
      kind: 'openrouter';
      apiKey: string;
      model: string;
      providers: string[];
      /** Tried in order when the model fails; empty for no cascade. */
      fallbacks: OpenRouterFallback[];
    };

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

/** Self-serve Free activations per rolling 24 hours, all instances, unless ASKR_FREE_PER_DAY says otherwise. */
export const DEFAULT_FREE_PER_DAY = 50;
/** Self-serve stores active on the Free tier at most, unless ASKR_FREE_MAX_ACTIVE says otherwise. */
export const DEFAULT_FREE_MAX_ACTIVE = 500;
/** As the operator CLI names a tier (`src/cli.ts`). */
const FREE_TIER_NAME_RE = /^[a-z0-9-]{1,32}$/;
/** The names before the rename, refused at start so a stale setting never silently turns Free off. */
const RENAMED_FREE_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['ASKR_AUTO_TIER', 'ASKR_FREE_TIER'],
  ['ASKR_AUTO_TIER_PER_DAY', 'ASKR_FREE_PER_DAY'],
  ['ASKR_AUTO_TIER_MAX_ACTIVE', 'ASKR_FREE_MAX_ACTIVE'],
];

/** The tier a merchant's explicit Free choice puts a store on, and the caps on how many (6.1). */
export interface FreeTier {
  tier: string;
  perDay: number;
  maxActive: number;
}

/**
 * ASKR_FREE_TIER (a tier name, e.g. free) with ASKR_FREE_PER_DAY and
 * ASKR_FREE_MAX_ACTIVE, checked at start. Unset: Free answers
 * `free_unavailable` and only the operator activates stores. A cap set
 * without the tier, or any old ASKR_AUTO_TIER* name, stops the server.
 */
export function freeTierFromEnv(rawEnv: Env): FreeTier | undefined {
  const env = withoutEmpty(rawEnv);
  for (const [oldName, newName] of RENAMED_FREE_SETTINGS) {
    if (env[oldName] !== undefined) {
      throw new Error(
        `${oldName} was renamed to ASKR_FREE_*: set ${newName} instead (and unset ${oldName}).`,
      );
    }
  }
  const tier = env.ASKR_FREE_TIER;
  if (tier === undefined) {
    for (const name of ['ASKR_FREE_PER_DAY', 'ASKR_FREE_MAX_ACTIVE']) {
      if (env[name] !== undefined) {
        throw new Error(`${name} is an ASKR_FREE_TIER setting: unset it without ASKR_FREE_TIER.`);
      }
    }
    return undefined;
  }
  if (!FREE_TIER_NAME_RE.test(tier)) {
    throw new Error(`ASKR_FREE_TIER must be a tier name (1 to 32 of a-z, 0-9 and -), got ${tier}`);
  }
  return {
    tier,
    perDay: positiveInteger(
      'ASKR_FREE_PER_DAY',
      env.ASKR_FREE_PER_DAY ?? String(DEFAULT_FREE_PER_DAY),
    ),
    maxActive: positiveInteger(
      'ASKR_FREE_MAX_ACTIVE',
      env.ASKR_FREE_MAX_ACTIVE ?? String(DEFAULT_FREE_MAX_ACTIVE),
    ),
  };
}

/**
 * A warning when the Free tier does not exist (yet): a Free choice is then
 * answered `free_unavailable`. Not a refusal to start, since the operator may
 * create it after.
 */
export async function freeTierWarning(
  freeTier: FreeTier,
  tiers: { tierExists: (name: string) => Promise<boolean> },
): Promise<string | undefined> {
  return (await tiers.tierExists(freeTier.tier))
    ? undefined
    : `ASKR_FREE_TIER names the tier ${freeTier.tier}, which does not exist: Free is unavailable until the operator creates it (askr-server tier set ${freeTier.tier} ...)`;
}

/** The Stripe secrets paid plans need (6.1): both, or billing is off. */
export interface BillingSecrets {
  secretKey: string;
  webhookSecret: string;
}

const BILLING_FILES = ['ASKR_STRIPE_SECRET_KEY_FILE', 'ASKR_STRIPE_WEBHOOK_SECRET_FILE'] as const;

/**
 * ASKR_STRIPE_SECRET_KEY_FILE and ASKR_STRIPE_WEBHOOK_SECRET_FILE: files holding the Stripe
 * restricted key and the webhook signing secret (Docker secrets, like the master key). Both unset:
 * billing is off (its routes answer `billing_unavailable`, paid plans go through us). One without
 * the other, or an empty file, stops the server. `read` is for tests. The values are never logged.
 */
export function billingFromEnv(
  rawEnv: Env,
  read: (path: string) => string,
): BillingSecrets | undefined {
  const env = withoutEmpty(rawEnv);
  const [keyFile, webhookFile] = BILLING_FILES.map((name) => env[name]);
  if (keyFile === undefined && webhookFile === undefined) {
    return undefined;
  }
  if (keyFile === undefined || webhookFile === undefined) {
    throw new Error(
      `Billing needs both ${BILLING_FILES.join(' and ')}: set both, or neither to turn billing off.`,
    );
  }
  const secretKey = read(keyFile).trim();
  const webhookSecret = read(webhookFile).trim();
  if (secretKey === '') {
    throw new Error('ASKR_STRIPE_SECRET_KEY_FILE names an empty file');
  }
  if (webhookSecret === '') {
    throw new Error('ASKR_STRIPE_WEBHOOK_SECRET_FILE names an empty file');
  }
  return { secretKey, webhookSecret };
}

const FALLBACK_FIELDS = 6;
const OPENROUTER_MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu;

/**
 * ASKR_OPENROUTER_FALLBACKS: the models to fall to, in order, when the main one fails (an
 * error, not an answer it gave), separated by `;`. Each is
 * `model|hosts|input|cached input|cache write|output`: its OpenRouter id, the hosts it may run
 * on (as ASKR_OPENROUTER_PROVIDERS, US or EU only) and its USD prices per million tokens.
 * Every call tries the main model first.
 */
export function openRouterFallbacksFrom(value: string | undefined): OpenRouterFallback[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const fields = entry.split('|').map((field) => field.trim());
      const [model, hosts, input, cachedInput, cacheWrite, output] = fields;
      if (
        fields.length !== FALLBACK_FIELDS ||
        model === undefined ||
        hosts === undefined ||
        input === undefined ||
        cachedInput === undefined ||
        cacheWrite === undefined ||
        output === undefined ||
        !OPENROUTER_MODEL_RE.test(model)
      ) {
        throw new Error(
          `ASKR_OPENROUTER_FALLBACKS entry must be model|hosts|input|cached input|cache write|output, got ${entry}`,
        );
      }
      const name = `ASKR_OPENROUTER_FALLBACKS ${model}`;
      return {
        model,
        providers: openRouterProvidersFrom(model, hosts),
        price: {
          input: positiveUsd(`${name} input price`, input),
          cachedInput: positiveUsd(`${name} cached input price`, cachedInput),
          cacheWrite: positiveUsd(`${name} cache write price`, cacheWrite),
          output: positiveUsd(`${name} output price`, output),
        },
      };
    });
}

/** ASKR_TURN_RESERVE_USD, or the default; checked (the operator CLI reads it too, to warn). */
export function turnReserveFromEnv(rawEnv: Env): string {
  const env = withoutEmpty(rawEnv);
  return positiveUsd(
    'ASKR_TURN_RESERVE_USD',
    env.ASKR_TURN_RESERVE_USD ?? DEFAULT_TURN_RESERVE_USD,
  );
}

export interface ServeConfig {
  model: ModelConfig;
  price: ModelPrice;
  reserveUsd: string;
  maxTokens: number;
  messagesPerIpPerDay: number;
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
      fallbacks: openRouterFallbacksFrom(env.ASKR_OPENROUTER_FALLBACKS),
    };
  } else {
    for (const name of ['ASKR_OPENROUTER_PROVIDERS', 'ASKR_OPENROUTER_FALLBACKS']) {
      if (env[name] !== undefined) {
        throw new Error(
          `${name} is an OpenRouter setting: unset it without ASKR_OPENROUTER_MODEL.`,
        );
      }
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
  const reserveUsd = turnReserveFromEnv(env);
  const maxTokens = positiveInteger(
    'ASKR_MAX_TOKENS',
    env.ASKR_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS),
  );
  // Any call of a turn may fall to any model of the cascade: each must fit the reservation.
  const fallbackPrices =
    model.kind === 'openrouter' ? model.fallbacks.map((entry) => entry.price) : [];
  for (const each of [price, ...fallbackPrices]) {
    checkTurnBudget({
      maxTokens,
      calls: MAX_MODEL_CALLS_PER_TURN,
      outputPricePerMillion: each.output,
      reserveUsd,
    });
  }
  const messagesPerIpPerDay = positiveInteger(
    'ASKR_MESSAGES_PER_IP_PER_DAY',
    env.ASKR_MESSAGES_PER_IP_PER_DAY ?? String(DEFAULT_MESSAGES_PER_IP_PER_DAY),
  );
  return { model, price, reserveUsd, maxTokens, messagesPerIpPerDay };
}

/** A failed call's kind with no content (4.4): "LlmError 503", or the error's name. */
function errorKind(error: unknown): string {
  if (error instanceof LlmError) {
    return `LlmError ${error.status ?? 'no status'}`;
  }
  return error instanceof Error ? error.name : 'unknown';
}

function openRouterProvider(
  apiKey: string,
  model: string,
  providers: string[],
  fetch: typeof globalThis.fetch | undefined,
): LlmProvider {
  return createOpenAiCompatibleProvider({
    apiKey,
    model,
    baseUrl: 'https://openrouter.ai/api/v1',
    // Anthropic models through OpenRouter need the cache marks passed through (5.7).
    passCacheMarks: model.startsWith('anthropic/'),
    // No training and zero data retention where offered (4.4); only the named hosts, with no
    // fallback to others (spec 8).
    extraBody: {
      provider: { data_collection: 'deny', only: providers, allow_fallbacks: false },
    },
    ...(fetch ? { fetch } : {}),
  });
}

/**
 * The provider for the configured model; with fallbacks, a cascade that tries the main model
 * first on every call. `log` hears each fallback; `fetch` is for tests.
 */
export function providerFor(
  config: ModelConfig,
  fetch?: typeof globalThis.fetch,
  log?: (message: string) => void,
): LlmProvider {
  if (config.kind === 'openrouter') {
    const main = openRouterProvider(config.apiKey, config.model, config.providers, fetch);
    if (config.fallbacks.length === 0) {
      return main;
    }
    return createCascadeProvider(
      [
        main,
        ...config.fallbacks.map((entry) =>
          openRouterProvider(config.apiKey, entry.model, entry.providers, fetch),
        ),
      ],
      (failed, next, error) =>
        log?.(`model ${failed} failed (${errorKind(error)}), trying ${next}`),
    );
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
  log?: (message: string) => void,
): {
  providerFor: () => LlmProvider;
  price: ModelPrice;
  fallbackPrices: Record<string, ModelPrice>;
  reserveUsd: string;
  maxTokens: number;
  messagesPerIpPerDay: number;
} {
  const provider = providerFor(config.model, fetch, log);
  const fallbacks = config.model.kind === 'openrouter' ? config.model.fallbacks : [];
  return {
    providerFor: () => provider,
    price: config.price,
    fallbackPrices: Object.fromEntries(fallbacks.map((entry) => [entry.model, entry.price])),
    reserveUsd: config.reserveUsd,
    maxTokens: config.maxTokens,
    messagesPerIpPerDay: config.messagesPerIpPerDay,
  };
}
