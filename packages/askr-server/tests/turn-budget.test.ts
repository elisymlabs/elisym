import { MAX_MODEL_CALLS_PER_TURN, MAX_TOOL_ROUNDS } from '@elisym/askr-agent';
import { describe, expect, it } from 'vitest';
import {
  checkTurnBudget,
  effortFrom,
  positiveInteger,
  providerFor,
  serveConfigFromEnv,
  workerSettings,
} from '../src/config';

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

/** A fetch that records each request body and answers with one plain text turn. */
function recordingFetch(kind: 'anthropic' | 'openai') {
  const bodies: Record<string, unknown>[] = [];
  const doFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    const reply =
      kind === 'anthropic'
        ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }
        : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} };
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { doFetch, bodies };
}

const REQUEST = {
  system: [{ text: 'S', cache: true }],
  messages: [],
  tools: [],
  maxTokens: 2_048,
};

describe('round 5: the provider and worker settings built from the configuration', () => {
  it('Anthropic gets the configured effort, none sends no effort', async () => {
    const low = recordingFetch('anthropic');
    await providerFor(serveConfigFromEnv(ANTHROPIC_ENV).model, low.doFetch).turn(REQUEST);
    expect(low.bodies[0]?.output_config).toEqual({ effort: 'low' });
    const none = recordingFetch('anthropic');
    await providerFor(
      serveConfigFromEnv({ ...ANTHROPIC_ENV, ASKR_EFFORT: 'none' }).model,
      none.doFetch,
    ).turn(REQUEST);
    expect(none.bodies[0]).not.toHaveProperty('output_config');
  });

  it('OpenRouter passes cache marks only for anthropic/ models, and always denies data collection', async () => {
    const env = { ...ANTHROPIC_ENV, OPENROUTER_API_KEY: 'or' };
    const claude = recordingFetch('openai');
    await providerFor(
      serveConfigFromEnv({ ...env, ASKR_OPENROUTER_MODEL: 'anthropic/claude-sonnet-5-5' }).model,
      claude.doFetch,
    ).turn(REQUEST);
    const deepseek = recordingFetch('openai');
    await providerFor(
      serveConfigFromEnv({ ...env, ASKR_OPENROUTER_MODEL: 'deepseek/deepseek-chat' }).model,
      deepseek.doFetch,
    ).turn(REQUEST);
    const systemOf = (body: Record<string, unknown> | undefined) =>
      Array.isArray(body?.messages) ? body.messages[0] : undefined;
    expect(systemOf(claude.bodies[0])).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
    });
    expect(systemOf(deepseek.bodies[0])).toEqual({ role: 'system', content: 'S' });
    expect(claude.bodies[0]?.provider).toEqual({ data_collection: 'deny' });
    expect(deepseek.bodies[0]?.provider).toEqual({ data_collection: 'deny' });
  });

  it('the worker gets the provider, price, reservation and max tokens', () => {
    const config = serveConfigFromEnv({
      ...ANTHROPIC_ENV,
      ASKR_TURN_RESERVE_USD: '1.5',
      ASKR_MAX_TOKENS: '3000',
    });
    const settings = workerSettings(config);
    expect(settings).toMatchObject({
      price: config.price,
      reserveUsd: '1.5',
      maxTokens: 3_000,
    });
    expect(settings.providerFor().model).toBe('claude-sonnet-5-5');
  });

  it('a larger reservation lets an Opus price start at the defaults', () => {
    const opus = { ...ANTHROPIC_ENV, ASKR_PRICE_OUTPUT: '20', ASKR_TURN_RESERVE_USD: '1' };
    expect(serveConfigFromEnv(opus).reserveUsd).toBe('1');
  });

  it('OpenRouter needs OPENROUTER_API_KEY', () => {
    expect(() =>
      serveConfigFromEnv({ ...ANTHROPIC_ENV, ASKR_OPENROUTER_MODEL: 'deepseek/deepseek-chat' }),
    ).toThrow('OPENROUTER_API_KEY is required');
  });

  it('an empty variable is an unset one', () => {
    const config = serveConfigFromEnv({
      ...ANTHROPIC_ENV,
      ASKR_EFFORT: '',
      ASKR_TURN_RESERVE_USD: '',
      ASKR_MAX_TOKENS: '',
      ASKR_OPENROUTER_MODEL: '',
    });
    expect(config).toMatchObject({
      model: { kind: 'anthropic', effort: 'low' },
      reserveUsd: '0.25',
      maxTokens: 2_048,
    });
    // An empty effort next to an OpenRouter model is unset too, not a refused setting.
    expect(
      serveConfigFromEnv({
        ...ANTHROPIC_ENV,
        ASKR_OPENROUTER_MODEL: 'deepseek/deepseek-chat',
        OPENROUTER_API_KEY: 'or',
        ASKR_EFFORT: '',
      }).model.kind,
    ).toBe('openrouter');
  });
});
