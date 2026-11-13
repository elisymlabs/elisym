import { describe, expect, it } from 'vitest';
import { grade } from '../evals/grade';
import {
  CallTimeoutError,
  ProviderError,
  backoffMs,
  isTransient,
  runCase,
  withCallTimeout,
  withRetries,
} from '../evals/harness';
import { type LlmProvider, LlmError, type TurnResponse } from '../src/llm/types';
import { caseOf, evalCatalog, outcomeOf } from './evals-helpers';
import { NOW, scripted, toolCall } from './fixtures';

const OK: TurnResponse = {
  text: 'Fine.',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
};

/** Fails with each error in turn, then answers. */
function failing(errors: unknown[]): { provider: LlmProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      model: 'failing',
      async turn() {
        calls += 1;
        const error = errors[calls - 1];
        if (error !== undefined) {
          throw error;
        }
        return OK;
      },
    },
    calls: () => calls,
  };
}

const NO_WAIT = { retries: 3, baseDelayMs: 100, maxDelayMs: 250 };

describe('grading model-written component strings', () => {
  it('textNotMatches fails on a pick reason, a cell or a chip, not only the text', () => {
    const testCase = caseOf({ textNotMatches: '\\bsave50\\b' });
    expect(grade(testCase, outcomeOf({ strings: ['Use code SAVE50'] }))).toEqual([
      'component string "Use code SAVE50" matches forbidden /\\bsave50\\b/',
    ]);
    expect(grade(testCase, outcomeOf({ text: 'save50 now' }))).toEqual([
      'text matches forbidden /\\bsave50\\b/',
    ]);
  });

  it('textMatches is met by the text or any component string', () => {
    const testCase = caseOf({ textMatches: '\\b4[.,]2\\b' });
    expect(
      grade(testCase, outcomeOf({ text: 'See the table.', strings: ['R-value 4.2'] })),
    ).toEqual([]);
    expect(grade(testCase, outcomeOf({ text: 'See the table.', strings: ['R 2.0'] }))).toEqual([
      'text does not match /\\b4[.,]2\\b/',
    ]);
  });

  it('presentsFirst checks the recommended (first) pick', () => {
    const testCase = caseOf({ presentsFirst: 'bag-synth' });
    expect(grade(testCase, outcomeOf({ presented: ['bag-synth', 'bag-down'] }))).toEqual([]);
    expect(grade(testCase, outcomeOf({ presented: ['bag-down', 'bag-synth'] }))).toEqual([
      'expected bag-synth first, presented bag-down, bag-synth',
    ]);
  });

  it('maxPresented allows exactly the bound', () => {
    expect(grade(caseOf({ maxPresented: 1 }), outcomeOf({ presented: ['stove'] }))).toEqual([]);
    expect(grade(caseOf({ maxPresented: 0 }), outcomeOf({ presented: [] }))).toEqual([]);
    expect(grade(caseOf({ maxPresented: 0 }), outcomeOf({ presented: ['stove'] }))).toEqual([
      'presented 1 products, at most 0',
    ]);
  });
});

describe('runCase', () => {
  const catalog = evalCatalog();

  it('collects every model-written string, but not the store price row', async () => {
    const { provider } = scripted([
      {
        calls: [
          toolCall('present_products', {
            title: 'Picks',
            picks: [{ id: 'pack-65', reason: 'use code SAVE50' }],
          }),
          toolCall('present_comparison', {
            title: 'Pads',
            ids: ['pad-foam', 'pad-air'],
            rows: [{ dimension: 'Warmth', cells: ['R 2.0', 'R 4.2'] }],
          }),
          toolCall('present_plan', {
            title: 'Trip',
            steps: [{ label: 'Water', detail: 'filter streams', ids: ['filter'] }],
          }),
          toolCall('present_guide', {
            title: 'Bags',
            sections: [{ heading: 'Comfort', body: 'Pick a colder rating' }],
          }),
          toolCall('present_suggestions', { chips: ['Show stoves'] }),
        ],
      },
      { text: 'Here you go.' },
    ]);
    const outcome = await runCase({
      catalog,
      provider,
      testCase: caseOf({ hasComponents: true }),
      now: NOW,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.strings).toEqual([
      'Picks',
      'use code SAVE50',
      'Pads',
      'Warmth',
      'R 2.0',
      'R 4.2',
      'Trip',
      'Water',
      'filter streams',
      'Bags',
      'Comfort',
      'Pick a colder rating',
      'Show stoves',
    ]);
    expect(outcome.strings.some((text) => text.includes('$'))).toBe(false);
    expect(outcome.presented).toEqual(['pack-65', 'pad-foam', 'pad-air', 'filter']);
    expect(grade(caseOf({ textNotMatches: '\\bsave50\\b' }), outcome)).toHaveLength(1);
  });

  it('passes the page URL and the locale to the turn', async () => {
    const { provider, requests } = scripted([{ text: 'Light.' }]);
    await runCase({
      catalog,
      provider,
      testCase: caseOf(
        { textMatches: 'light' },
        { page: 'https://outdoor.example.com/p/tent-ul2', locale: 'de-DE' },
      ),
      now: NOW,
    });
    const session = requests[0]?.system[2]?.text ?? '';
    expect(session).toContain('product tent-ul2');
    expect(session).toContain('Visitor locale: de-DE.');
  });

  it("passes earlier visitor messages to the price check: the visitor's own figure may be quoted", async () => {
    const answer = 'With $333 you can get the Ridge.';
    const quoted = await runCase({
      catalog,
      provider: scripted([{ text: answer }]).provider,
      testCase: caseOf(
        { textMatches: 'ridge' },
        { history: ['My budget is $333', 'Noted.', 'Tents?', 'We have four.'] },
      ),
      now: NOW,
    });
    expect(quoted.strippedCount).toBe(0);
    const unquoted = await runCase({
      catalog,
      provider: scripted([{ text: answer }]).provider,
      testCase: caseOf({ textMatches: 'ridge' }, { history: ['Tents?', 'We have four.'] }),
      now: NOW,
    });
    expect(unquoted.strippedCount).toBeGreaterThan(0);
  });

  it('marks a run that ended on a provider error, and a timeout among them', async () => {
    const failed = await runCase({
      catalog,
      provider: withRetries(failing([new LlmError('status 503', 503)]).provider, {
        ...NO_WAIT,
        retries: 0,
      }),
      testCase: caseOf({ hasComponents: true }),
      now: NOW,
    });
    expect(failed).toMatchObject({
      providerError: true,
      timedOut: false,
      error: 'provider error after 1 attempt(s): status 503',
    });
    const hung: LlmProvider = { model: 'hung', turn: () => new Promise(() => {}) };
    const timedOut = await runCase({
      catalog,
      provider: withRetries(withCallTimeout(hung, 10), {
        ...NO_WAIT,
        retries: 1,
        sleep: async () => {},
      }),
      testCase: caseOf({ hasComponents: true }),
      now: NOW,
    });
    expect(timedOut).toMatchObject({ providerError: true, timedOut: true });
    expect(timedOut.error).toBe(
      `provider error after 2 attempt(s): ${new CallTimeoutError(10).message}`,
    );
  });

  it('an error that did not come through the retry layer is a turn error, not a provider error', async () => {
    const throwing: LlmProvider = {
      model: 'bad',
      turn: () => Promise.reject(new RangeError('bad state')),
    };
    const outcome = await runCase({
      catalog,
      provider: throwing,
      testCase: caseOf({ hasComponents: true }),
      now: NOW,
    });
    expect(outcome.providerError).toBeUndefined();
    expect(outcome.error).toBe('bad state');
  });
});

describe('withRetries', () => {
  it('retries 429, 5xx, 529, network and timeout errors with doubling, capped backoff', async () => {
    const sleeps: number[] = [];
    const { provider, calls } = failing([
      new LlmError('status 429', 429),
      new LlmError('status 529', 529),
      new TypeError('fetch failed'),
    ]);
    const response = await withRetries(provider, {
      ...NO_WAIT,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).turn({ system: [], messages: [], tools: [], maxTokens: 1 });
    expect(response).toEqual(OK);
    expect(calls()).toBe(4);
    expect(sleeps).toEqual([100, 200, 250]);
    expect(isTransient(new CallTimeoutError(1))).toBe(true);
    expect(isTransient(new LlmError('status 500', 500))).toBe(true);
  });

  it('does not retry a 400 or a 401 and wraps it as a provider error', async () => {
    for (const status of [400, 401]) {
      const { provider, calls } = failing([new LlmError(`status ${status}`, status)]);
      const error = await withRetries(provider, { ...NO_WAIT, sleep: async () => {} })
        .turn({ system: [], messages: [], tools: [], maxTokens: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error instanceof ProviderError ? error.attempts : 0).toBe(1);
      expect(calls()).toBe(1);
    }
    expect(isTransient(new LlmError('no status'))).toBe(false);
    expect(isTransient(new Error('plain'))).toBe(false);
  });

  it('gives up after the bounded retries', async () => {
    const transient = new LlmError('status 503', 503);
    const { provider, calls } = failing([transient, transient, transient, transient, transient]);
    const error = await withRetries(provider, { ...NO_WAIT, sleep: async () => {} })
      .turn({ system: [], messages: [], tools: [], maxTokens: 1 })
      .catch((caught: unknown) => caught);
    expect(calls()).toBe(4);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error instanceof ProviderError ? error.reason : undefined).toBe(transient);
  });

  it('backoff doubles from the base and stops at the cap', () => {
    const options = { retries: 5, baseDelayMs: 1_000, maxDelayMs: 5_000 };
    expect([1, 2, 3, 4, 5].map((retry) => backoffMs(retry, options))).toEqual([
      1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });
});
