import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ProviderSpec, resolveModels } from '../evals/models';
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

describe('the models file', () => {
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
