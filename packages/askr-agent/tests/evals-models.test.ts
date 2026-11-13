import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ProviderSpec, createProvider, resolveModels } from '../evals/models';
import type { LlmProvider } from '../src/llm/types';
import { EVALS_DIR } from './evals-helpers';

const ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENROUTER_API_KEY: 'or-test',
  DEEPSEEK_API_KEY: 'ds-test',
};
const FILLED = { input: '1', cachedInput: '0.1', cacheWrite: '1.25', output: '5' };

function fake(specs: ProviderSpec[]) {
  return (spec: ProviderSpec): LlmProvider => {
    specs.push(spec);
    return { model: spec.model, turn: () => Promise.reject(new Error('not called')) };
  };
}

function example() {
  return JSON.parse(readFileSync(join(EVALS_DIR, 'models.example.json'), 'utf8'));
}

/** The example with every price filled and the OpenRouter route named. */
function filledExample() {
  const json = example();
  for (const entry of json.models) {
    entry.price = FILLED;
    if (entry.extraBody?.provider?.only) {
      entry.extraBody.provider.only = ['us-host'];
    }
  }
  return json;
}

function refusal(json: unknown, env: Record<string, string> = ENV): string {
  try {
    resolveModels(json, { env, createProvider: fake([]) });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('the models file', () => {
  it('passes effort to an Anthropic entry and max tokens to its runs; refuses effort elsewhere', () => {
    const json = filledExample();
    json.models[0].effort = 'low';
    json.models[0].maxTokens = 4_000;
    const specs: ProviderSpec[] = [];
    const models = resolveModels(json, { env: ENV, createProvider: fake(specs) });
    expect(specs[0]?.effort).toBe('low');
    expect(specs[1]?.effort).toBeUndefined();
    expect(models[0]?.maxTokens).toBe(4_000);
    expect(models[1]?.maxTokens).toBeUndefined();
    const wrong = filledExample();
    wrong.models[4].effort = 'low';
    expect(refusal(wrong)).toBe(
      'Model entry "gemini-flash-openrouter": effort is an Anthropic setting; remove it for openrouter.',
    );
    const unknown = filledExample();
    unknown.models[0].effort = 'extreme';
    expect(refusal(unknown)).toMatch(/The models file is invalid: models\.0\.effort/);
  });

  it('refuses OpenRouter route bypasses: fallback models, a route key, openrouter/* ids', () => {
    for (const key of ['models', 'route']) {
      const json = filledExample();
      json.models[4].extraBody[key] = key === 'models' ? ['deepseek/deepseek-chat'] : 'fallback';
      expect(refusal(json)).toMatch(new RegExp(`extraBody\\.${key} would route to other models`));
    }
    const auto = filledExample();
    auto.models[4].model = 'openrouter/auto';
    expect(refusal(auto)).toBe(
      'Model entry "gemini-flash-openrouter": "openrouter/auto" lets OpenRouter pick the model; name one.',
    );
  });

  it('a DeepSeek model in any casing or under any author needs named hosts', () => {
    for (const model of ['DeepSeek/DeepSeek-Chat', 'tngtech/deepseek-r1t-chimera']) {
      const json = filledExample();
      json.models[4].model = model;
      expect(refusal(json), model).toMatch(/a DeepSeek model needs it/);
      json.models[4].extraBody.provider.only = ['us-host'];
      expect(refusal(json), model).toBe('');
    }
  });

  it('refuses a negative price and a whitespace-only key, and trims prices', () => {
    const negative = filledExample();
    negative.models[0].price = { ...FILLED, input: '-1' };
    expect(refusal(negative)).toMatch(
      /price\.input must be a non-negative decimal string, got "-1"/,
    );
    expect(refusal(filledExample(), { ...ENV, ANTHROPIC_API_KEY: '   ' })).toBe(
      'Model entry "claude-haiku-5-5" (anthropic) needs ANTHROPIC_API_KEY set in the environment.',
    );
    const padded = filledExample();
    padded.models[0].price = {
      input: ' 1 ',
      cachedInput: '0.1 ',
      cacheWrite: ' 1.25',
      output: '5',
    };
    const models = resolveModels(padded, { env: ENV, createProvider: fake([]) });
    expect(models[0]?.price).toEqual(FILLED);
  });

  it('refuses extraBody on an anthropic entry', () => {
    const json = filledExample();
    json.models[0].extraBody = { provider: { data_collection: 'deny' } };
    expect(refusal(json)).toBe(
      'Model entry "claude-haiku-5-5": extraBody is not used by the anthropic provider; remove it.',
    );
  });

  it('a DeepSeek model on OpenRouter needs named hosts, never DeepSeek itself', () => {
    const missing = filledExample();
    delete missing.models[2].extraBody.provider.only;
    expect(refusal(missing)).toMatch(/provider\.only is empty.*a DeepSeek model needs it/);
    for (const host of ['deepseek', ' DeepSeek ']) {
      const own = filledExample();
      own.models[2].extraBody.provider.only = ['us-host', host];
      expect(refusal(own)).toMatch(/never DeepSeek's own endpoint/);
    }
    const gemini = filledExample();
    expect(gemini.models[4].extraBody.provider.only).toBeUndefined();
    expect(refusal(gemini)).toBe('');
  });

  it('the example has the plan matrix with every price left empty', () => {
    const json = example();
    expect(json.models.map((entry: { id: string }) => entry.id)).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'deepseek-openrouter',
      'deepseek-direct',
      'gemini-flash-openrouter',
    ]);
    for (const entry of json.models) {
      expect(Object.values(entry.price)).toEqual(['', '', '', '']);
    }
    const direct = json.models.find((entry: { id: string }) => entry.id === 'deepseek-direct');
    expect(direct.reference).toBe(true);
  });

  it('refuses an empty price, naming the entry and where prices come from', () => {
    expect(() => resolveModels(example(), { env: ENV, createProvider: fake([]) })).toThrow(
      /Model entry "claude-haiku-5-5": price\.input is empty\. Fill every price .* from the provider's pricing page/,
    );
  });

  it('refuses a price that is not a decimal string', () => {
    const json = filledExample();
    json.models[0].price = { ...FILLED, output: '1e-6' };
    expect(() => resolveModels(json, { env: ENV, createProvider: fake([]) })).toThrow(
      /price\.output must be a non-negative decimal string/,
    );
  });

  it('refuses a missing API key with the variable name and never the value of another key', () => {
    let message = '';
    try {
      resolveModels(filledExample(), {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        createProvider: fake([]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe(
      'Model entry "deepseek-openrouter" (openrouter) needs OPENROUTER_API_KEY set in the environment.',
    );
    expect(message).not.toContain('sk-ant-test');
  });

  it('refuses an unknown provider kind', () => {
    const json = filledExample();
    json.models[0].provider = 'bedrock';
    expect(() => resolveModels(json, { env: ENV, createProvider: fake([]) })).toThrow(
      'Model entry "claude-haiku-5-5": unknown provider "bedrock"; use one of anthropic, openrouter, deepseek.',
    );
  });

  it('refuses direct DeepSeek unless reference only, OpenRouter without data_collection deny, and an empty route list', () => {
    const direct = filledExample();
    direct.models[3].reference = false;
    expect(() => resolveModels(direct, { env: ENV, createProvider: fake([]) })).toThrow(
      /must be "reference": true/,
    );
    const training = filledExample();
    training.models[4].extraBody = { provider: {} };
    expect(() => resolveModels(training, { env: ENV, createProvider: fake([]) })).toThrow(
      /data_collection "deny"/,
    );
    const unrouted = filledExample();
    unrouted.models[2].extraBody.provider.only = [];
    expect(() => resolveModels(unrouted, { env: ENV, createProvider: fake([]) })).toThrow(
      /extraBody\.provider\.only is empty/,
    );
  });

  it('builds every provider from env keys and the entry fields', () => {
    const specs: ProviderSpec[] = [];
    const models = resolveModels(filledExample(), { env: ENV, createProvider: fake(specs) });
    expect(models.map((model) => [model.id, model.kind, model.reference])).toEqual([
      ['claude-haiku-5-5', 'anthropic', false],
      ['claude-sonnet-5-5', 'anthropic', false],
      ['deepseek-openrouter', 'openrouter', false],
      ['deepseek-direct', 'deepseek', true],
      ['gemini-flash-openrouter', 'openrouter', false],
    ]);
    expect(specs.map((spec) => spec.apiKey)).toEqual([
      'sk-ant-test',
      'sk-ant-test',
      'or-test',
      'ds-test',
      'or-test',
    ]);
    expect(specs[2]?.extraBody).toEqual({
      provider: { data_collection: 'deny', only: ['us-host'], allow_fallbacks: false },
    });
    expect(models[0]?.price).toEqual(FILLED);
  });

  it('--only keeps the named entries, which alone need prices and keys', () => {
    const json = example();
    json.models[0].price = FILLED;
    const models = resolveModels(json, {
      env: { ANTHROPIC_API_KEY: 'k' },
      only: ['claude-haiku-5-5'],
      createProvider: fake([]),
    });
    expect(models.map((model) => model.id)).toEqual(['claude-haiku-5-5']);
    expect(() =>
      resolveModels(json, { env: ENV, only: ['gpt-9'], createProvider: fake([]) }),
    ).toThrow('--only names unknown model entries: gpt-9.');
  });

  it('wires each provider kind to its endpoint, key and body', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      seen.push({
        url: String(input),
        headers,
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
      });
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const request = { system: [], messages: [], tools: [], maxTokens: 1 };
    const route = {
      provider: { data_collection: 'deny', only: ['us-host'], allow_fallbacks: false },
    };
    await createProvider({
      kind: 'anthropic',
      apiKey: 'a-key',
      model: 'claude-haiku-5-5',
      fetch: fakeFetch,
    }).turn(request);
    await createProvider({
      kind: 'openrouter',
      apiKey: 'or-key',
      model: 'deepseek/deepseek-chat',
      extraBody: route,
      fetch: fakeFetch,
    }).turn(request);
    await createProvider({
      kind: 'deepseek',
      apiKey: 'ds-key',
      model: 'deepseek-chat',
      fetch: fakeFetch,
    }).turn(request);
    expect(seen.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.deepseek.com/v1/chat/completions',
    ]);
    expect(seen[0]?.headers['x-api-key']).toBe('a-key');
    expect(seen[0]?.body.model).toBe('claude-haiku-5-5');
    expect(seen[1]?.headers.authorization).toBe('Bearer or-key');
    expect(seen[1]?.body.provider).toEqual(route.provider);
    expect(seen[1]?.body.model).toBe('deepseek/deepseek-chat');
    expect(seen[2]?.headers.authorization).toBe('Bearer ds-key');
    expect(seen[2]?.body.provider).toBeUndefined();
  });

  it('refuses a duplicate id and an invalid file', () => {
    const json = filledExample();
    json.models.push(json.models[0]);
    expect(() => resolveModels(json, { env: ENV, createProvider: fake([]) })).toThrow(
      'Model entry "claude-haiku-5-5" appears twice.',
    );
    expect(() => resolveModels({ models: [{ id: 'x' }] }, { env: ENV })).toThrow(
      /The models file is invalid/,
    );
  });
});
