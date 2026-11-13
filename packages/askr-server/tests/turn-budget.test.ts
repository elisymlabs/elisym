import { MAX_MODEL_CALLS_PER_TURN, MAX_TOOL_ROUNDS } from '@elisym/askr-agent';
import { describe, expect, it } from 'vitest';
import { checkTurnBudget, effortFrom, positiveInteger, serveConfigFromEnv } from '../src/config';

describe('a turn reservation must pay for the most output a turn can make', () => {
  it('counts every model call of a turn', () => {
    expect(MAX_MODEL_CALLS_PER_TURN).toBe(MAX_TOOL_ROUNDS + 2);
  });

  it('passes at exactly the reservation and refuses one token more, naming the numbers', () => {
    // 8 calls x 3125 tokens at 10 USD per million = 0.25 USD.
    const budget = { calls: 8, outputPricePerMillion: '10', reserveUsd: '0.25' };
    expect(() => checkTurnBudget({ ...budget, maxTokens: 3_125 })).not.toThrow();
    expect(() => checkTurnBudget({ ...budget, maxTokens: 3_126 })).toThrow(
      'A turn can spend up to 0.25008 USD on output (8 calls x 3126 max tokens at 10 USD per million), more than ASKR_TURN_RESERVE_USD 0.25. Lower ASKR_MAX_TOKENS (with a lower ASKR_EFFORT so thinking fits) or raise ASKR_TURN_RESERVE_USD.',
    );
  });

  it('the default 2048 tokens fits the default reservation on a Sonnet-priced model, not an Opus-priced one', () => {
    const defaults = { maxTokens: 2_048, calls: MAX_MODEL_CALLS_PER_TURN, reserveUsd: '0.25' };
    expect(() => checkTurnBudget({ ...defaults, outputPricePerMillion: '10' })).not.toThrow();
    expect(() => checkTurnBudget({ ...defaults, outputPricePerMillion: '20' })).toThrow(
      /more than ASKR_TURN_RESERVE_USD 0.25/,
    );
  });

  it('reads ASKR_MAX_TOKENS as a whole number above zero', () => {
    expect(positiveInteger('ASKR_MAX_TOKENS', '2048')).toBe(2_048);
    for (const bad of ['0', '-1', '1.5', '2e3', '', 'abc', '01']) {
      expect(() => positiveInteger('ASKR_MAX_TOKENS', bad), bad).toThrow(
        'ASKR_MAX_TOKENS must be a whole number above zero',
      );
    }
  });

  it('ASKR_EFFORT is low by default and must be a known level', () => {
    expect(effortFrom(undefined)).toBe('low');
    expect(effortFrom('high')).toBe('high');
    expect(effortFrom('none')).toBeUndefined();
    expect(() => effortFrom('extreme')).toThrow(
      'ASKR_EFFORT must be one of low, medium, high, xhigh, max or none, got extreme',
    );
  });
});

const ANTHROPIC_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-k',
  ASKR_MODEL: 'claude-sonnet-5-5',
  ASKR_PRICE_INPUT: '2',
  ASKR_PRICE_CACHED_INPUT: '0.2',
  ASKR_PRICE_CACHE_WRITE: '2.5',
  ASKR_PRICE_OUTPUT: '10',
};

describe('serveConfigFromEnv: the model and turn budget the server starts with', () => {
  it('Anthropic with low effort, 2048 max tokens and a 0.25 USD reservation by default', () => {
    expect(serveConfigFromEnv(ANTHROPIC_ENV)).toEqual({
      model: { kind: 'anthropic', apiKey: 'sk-ant-k', model: 'claude-sonnet-5-5', effort: 'low' },
      price: { input: '2', cachedInput: '0.2', cacheWrite: '2.5', output: '10' },
      reserveUsd: '0.25',
      maxTokens: 2_048,
    });
  });

  it('ASKR_EFFORT=none sends no effort, for models without the parameter', () => {
    const config = serveConfigFromEnv({
      ...ANTHROPIC_ENV,
      ASKR_EFFORT: 'none',
      ASKR_MODEL: 'claude-haiku-4-5',
    });
    expect(config.model).toEqual({
      kind: 'anthropic',
      apiKey: 'sk-ant-k',
      model: 'claude-haiku-4-5',
    });
  });

  it('refuses ASKR_EFFORT with an OpenRouter model, and runs OpenRouter without it', () => {
    const openRouter = {
      ...ANTHROPIC_ENV,
      ASKR_OPENROUTER_MODEL: 'deepseek/deepseek-chat',
      OPENROUTER_API_KEY: 'or',
    };
    expect(() => serveConfigFromEnv({ ...openRouter, ASKR_EFFORT: 'low' })).toThrow(
      'ASKR_EFFORT is an Anthropic setting and is not passed to OpenRouter: unset it with ASKR_OPENROUTER_MODEL.',
    );
    expect(serveConfigFromEnv(openRouter).model).toEqual({
      kind: 'openrouter',
      apiKey: 'or',
      model: 'deepseek/deepseek-chat',
    });
  });

  it('refuses to start on an Opus price at the defaults, and starts once max tokens fit', () => {
    const opus = { ...ANTHROPIC_ENV, ASKR_MODEL: 'claude-opus-5-5', ASKR_PRICE_OUTPUT: '20' };
    expect(() => serveConfigFromEnv(opus)).toThrow(/more than ASKR_TURN_RESERVE_USD 0.25/);
    expect(serveConfigFromEnv({ ...opus, ASKR_MAX_TOKENS: '1500' }).maxTokens).toBe(1_500);
    expect(() => serveConfigFromEnv({ ...opus, ASKR_MAX_TOKENS: 'lots' })).toThrow(
      'ASKR_MAX_TOKENS must be a whole number above zero',
    );
  });

  it('names a missing setting', () => {
    expect(() => serveConfigFromEnv({ ...ANTHROPIC_ENV, ASKR_MODEL: '' })).toThrow(
      'ASKR_MODEL is required',
    );
    expect(() => serveConfigFromEnv({ ...ANTHROPIC_ENV, ASKR_PRICE_OUTPUT: undefined })).toThrow(
      'ASKR_PRICE_OUTPUT is required',
    );
  });
});
