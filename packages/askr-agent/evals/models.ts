/**
 * The sweep's model matrix: a JSON file of entries (provider kind, model id,
 * prices per million tokens). Prices are filled at run time from the
 * provider's pricing page and never hard-coded; API keys come only from the
 * environment and are never printed.
 */
import { z } from 'zod';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { createOpenAiCompatibleProvider } from '../src/llm/openai-compatible';
import type { LlmProvider, ModelPrice } from '../src/llm/types';
import type { ModelInfo } from './aggregate';

export const PROVIDER_KINDS = ['anthropic', 'openrouter', 'deepseek'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const API_KEY_ENV: Readonly<Record<ProviderKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const PRICE_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output'] as const;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

const EntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    label: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** Measured for comparison only: never a tier default. */
    reference: z.boolean().default(false),
    note: z.string().optional(),
    extraBody: z.record(z.unknown()).optional(),
    price: z
      .object({
        input: z.string(),
        cachedInput: z.string(),
        cacheWrite: z.string(),
        output: z.string(),
      })
      .strict(),
  })
  .strict();
export type ModelEntry = z.infer<typeof EntrySchema>;

const ModelsFileSchema = z.object({ models: z.array(EntrySchema).min(1) }).strict();

export interface ProviderSpec {
  kind: ProviderKind;
  apiKey: string;
  model: string;
  extraBody?: Record<string, unknown>;
  /** Tests only: the fetch the adapter uses. */
  fetch?: typeof fetch;
}

export type ProviderFactory = (spec: ProviderSpec) => LlmProvider;

export interface ResolvedModel extends ModelInfo {
  kind: ProviderKind;
  provider: LlmProvider;
}

export const createProvider: ProviderFactory = (spec) => {
  switch (spec.kind) {
    case 'anthropic':
      return createAnthropicProvider({
        apiKey: spec.apiKey,
        model: spec.model,
        ...(spec.fetch ? { fetch: spec.fetch } : {}),
      });
    case 'openrouter':
      return createOpenAiCompatibleProvider({
        apiKey: spec.apiKey,
        model: spec.model,
        baseUrl: OPENROUTER_BASE_URL,
        passCacheMarks: spec.model.startsWith('anthropic/'),
        ...(spec.extraBody ? { extraBody: spec.extraBody } : {}),
        ...(spec.fetch ? { fetch: spec.fetch } : {}),
      });
    case 'deepseek':
      return createOpenAiCompatibleProvider({
        apiKey: spec.apiKey,
        model: spec.model,
        baseUrl: DEEPSEEK_BASE_URL,
        ...(spec.extraBody ? { extraBody: spec.extraBody } : {}),
        ...(spec.fetch ? { fetch: spec.fetch } : {}),
      });
  }
};

function isProviderKind(value: string): value is ProviderKind {
  return PROVIDER_KINDS.some((kind) => kind === value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function checkPrice(entry: ModelEntry): ModelPrice {
  for (const field of PRICE_FIELDS) {
    const value = entry.price[field].trim();
    if (value.length === 0) {
      throw new Error(
        `Model entry "${entry.id}": price.${field} is empty. Fill every price (USD per million tokens) from the provider's pricing page before the run; prices are never hard-coded.`,
      );
    }
    if (!DECIMAL_RE.test(value)) {
      throw new Error(
        `Model entry "${entry.id}": price.${field} must be a non-negative decimal string, got "${value}".`,
      );
    }
  }
  return {
    input: entry.price.input.trim(),
    cachedInput: entry.price.cachedInput.trim(),
    cacheWrite: entry.price.cacheWrite.trim(),
    output: entry.price.output.trim(),
  };
}

/** OpenRouter's slug for DeepSeek's own (China-hosted) endpoint. */
const DEEPSEEK_HOST_RE = /^deepseek$/i;

/**
 * Visitor-data rules (4.4, spec 8): no training on OpenRouter, a DeepSeek model
 * there only on hosts the entry names (never DeepSeek's own), direct DeepSeek
 * only as reference.
 */
function checkRoute(entry: ModelEntry, kind: ProviderKind): void {
  if (kind === 'anthropic' && entry.extraBody !== undefined) {
    throw new Error(
      `Model entry "${entry.id}": extraBody is not used by the anthropic provider; remove it.`,
    );
  }
  if (kind === 'deepseek' && !entry.reference) {
    throw new Error(
      `Model entry "${entry.id}": a direct DeepSeek API entry must be "reference": true (visitor data never goes to China-hosted endpoints by default).`,
    );
  }
  if (kind === 'openrouter') {
    const route = recordOf(recordOf(entry.extraBody).provider);
    if (route.data_collection !== 'deny') {
      throw new Error(
        `Model entry "${entry.id}": an OpenRouter entry needs extraBody.provider.data_collection "deny".`,
      );
    }
    const only = route.only;
    const isDeepSeek = entry.model.toLowerCase().startsWith('deepseek/');
    if ((only !== undefined || isDeepSeek) && (!Array.isArray(only) || only.length === 0)) {
      throw new Error(
        `Model entry "${entry.id}": extraBody.provider.only is empty. List the US/EU-hosted providers to route to (see the model's providers on OpenRouter)${isDeepSeek ? '; a DeepSeek model needs it' : ', or remove the field'}.`,
      );
    }
    if (
      Array.isArray(only) &&
      only.some((host) => typeof host !== 'string' || DEEPSEEK_HOST_RE.test(host.trim()))
    ) {
      throw new Error(
        `Model entry "${entry.id}": extraBody.provider.only must name hosts as strings and never DeepSeek's own endpoint.`,
      );
    }
  }
}

export interface ResolveOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Entry ids to keep; all when absent. Only kept entries need prices and keys. */
  only?: readonly string[];
  createProvider?: ProviderFactory;
}

export function resolveModels(json: unknown, options: ResolveOptions): ResolvedModel[] {
  const parsed = ModelsFileSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`The models file is invalid: ${detail}`);
  }
  const entries = parsed.data.models;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Model entry "${entry.id}" appears twice.`);
    }
    ids.add(entry.id);
    if (!isProviderKind(entry.provider)) {
      throw new Error(
        `Model entry "${entry.id}": unknown provider "${entry.provider}"; use one of ${PROVIDER_KINDS.join(', ')}.`,
      );
    }
  }
  const only = options.only;
  const unknown = (only ?? []).filter((id) => !ids.has(id));
  if (unknown.length > 0) {
    throw new Error(`--only names unknown model entries: ${unknown.join(', ')}.`);
  }
  const selected = only ? entries.filter((entry) => only.includes(entry.id)) : entries;
  const factory = options.createProvider ?? createProvider;
  return selected.map((entry) => {
    if (!isProviderKind(entry.provider)) {
      throw new Error(`Model entry "${entry.id}": unknown provider "${entry.provider}".`);
    }
    const kind = entry.provider;
    const price = checkPrice(entry);
    checkRoute(entry, kind);
    const variable = API_KEY_ENV[kind];
    const apiKey = options.env[variable] ?? '';
    if (apiKey.trim().length === 0) {
      throw new Error(
        `Model entry "${entry.id}" (${kind}) needs ${variable} set in the environment.`,
      );
    }
    return {
      id: entry.id,
      label: entry.label,
      model: entry.model,
      reference: entry.reference,
      price,
      kind,
      provider: factory({
        kind,
        apiKey,
        model: entry.model,
        ...(entry.extraBody ? { extraBody: entry.extraBody } : {}),
      }),
    };
  });
}
