import { describe, expect, it } from 'vitest';
import { grade } from '../evals/grade';
import { CallTimeoutError, runCase, withCallTimeout } from '../evals/harness';
import type { LlmProvider, TurnRequest } from '../src/llm/types';
import { caseOf, evalCatalog, outcomeOf } from './evals-helpers';
import { NOW, scripted, toolCall } from './fixtures';

describe('grade', () => {
  it('passes an answer that meets every check', () => {
    const testCase = caseOf({
      presentsAny: ['tent-2p', 'tent-1p'],
      presentsAll: ['tent-2p'],
      presentsNone: ['tent-4p'],
      maxPresented: 2,
      hasComponents: true,
      textMatches: ['tent', 'two'],
      textNotMatches: 'free',
    });
    const outcome = outcomeOf({
      text: 'The Ridge tent sleeps two.',
      presented: ['tent-2p'],
      componentCount: 1,
    });
    expect(grade(testCase, outcome)).toEqual([]);
  });

  it('names a presentsAny miss with what was presented', () => {
    expect(
      grade(caseOf({ presentsAny: ['tent-2p'] }), outcomeOf({ presented: ['tent-1p'] })),
    ).toEqual(['expected one of tent-2p, presented tent-1p']);
    expect(grade(caseOf({ presentsAny: ['tent-2p'] }), outcomeOf())).toEqual([
      'expected one of tent-2p, presented nothing',
    ]);
  });

  it('names what presentsAll missed', () => {
    expect(
      grade(caseOf({ presentsAll: ['stove', 'pot'] }), outcomeOf({ presented: ['stove'] })),
    ).toEqual(['expected all of pot too, presented stove']);
  });

  it('fails a presentsNone hit and too many products', () => {
    expect(
      grade(
        caseOf({ presentsNone: ['bag-down'], maxPresented: 1 }),
        outcomeOf({ presented: ['bag-synth', 'bag-down'] }),
      ),
    ).toEqual(['presented forbidden bag-down', 'presented 2 products, at most 1']);
  });

  it('fails hasComponents and noComponents', () => {
    expect(grade(caseOf({ hasComponents: true }), outcomeOf())).toEqual(['expected a component']);
    expect(grade(caseOf({ noComponents: true }), outcomeOf({ componentCount: 1 }))).toEqual([
      'expected no components',
    ]);
  });

  it('checks every textMatches pattern and every textNotMatches pattern, case-insensitively', () => {
    const testCase = caseOf({
      textMatches: ['sold out', 'lamp'],
      textNotMatches: ['evil\\.example'],
    });
    expect(grade(testCase, outcomeOf({ text: 'The HEADLAMP is Sold Out.' }))).toEqual([]);
    expect(
      grade(testCase, outcomeOf({ text: 'Sold out. See evil.example.com for a lamp.' })),
    ).toEqual(['text matches forbidden /evil\\.example/']);
    expect(grade(testCase, outcomeOf({ text: 'In stock.' }))).toEqual([
      'text does not match /sold out/',
      'text does not match /lamp/',
    ]);
  });

  it('fails an answer the price check had to strip', () => {
    expect(grade(caseOf({ textMatches: 'tent' }), outcomeOf({ strippedCount: 2 }))).toEqual([
      'price check stripped 2 string(s) after the re-run',
    ]);
  });

  it('reports a turn error alone', () => {
    expect(grade(caseOf({ noComponents: true }), outcomeOf({ error: 'status 529' }))).toEqual([
      'turn error: status 529',
    ]);
  });
});

describe('runCase', () => {
  const catalog = evalCatalog();

  it('runs a turn and records ids, usage, calls and latency', async () => {
    const { provider } = scripted([
      { calls: [toolCall('present_products', { picks: [{ id: 'tent-2p' }, { id: 'tent-1p' }] })] },
      { text: 'Two tents that fit.' },
    ]);
    let tick = 0;
    const outcome = await runCase({
      catalog,
      provider,
      testCase: caseOf({ presentsAny: ['tent-2p'] }),
      now: NOW,
      repeat: 3,
      clock: () => {
        tick += 1;
        return tick === 1 ? 1_000 : 2_234.4;
      },
    });
    expect(outcome).toMatchObject({
      caseId: 'case-1',
      repeat: 3,
      text: 'Two tents that fit.',
      presented: ['tent-2p', 'tent-1p'],
      componentCount: 1,
      strippedCount: 0,
      modelCalls: 2,
      latencyMs: 1_234,
      usage: { inputTokens: 200, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 40 },
    });
    expect(outcome.error).toBeUndefined();
  });

  it('records what the price check stripped, and grading fails it', async () => {
    const { provider } = scripted([
      { calls: [toolCall('present_products', { picks: [{ id: 'tent-2p' }] })] },
      { text: 'It is on sale for $99 today.' },
    ]);
    const testCase = caseOf({ presentsAny: ['tent-2p'] });
    const outcome = await runCase({ catalog, provider, testCase, now: NOW });
    expect(outcome.strippedCount).toBeGreaterThan(0);
    expect(grade(testCase, outcome)).toEqual([
      expect.stringMatching(/^price check stripped \d+ string\(s\)/),
    ]);
  });

  it('fences history visitor messages and passes earlier policy passages to the price check', async () => {
    const answer = 'EU shipping is €15 flat.';
    const withPolicy = scripted([{ text: answer }]);
    const history = ['Shipping to France?', 'Let me check.'];
    const quoted = await runCase({
      catalog,
      provider: withPolicy.provider,
      testCase: caseOf({ textMatches: '15' }, { history, earlierPolicies: ['shipping'] }),
      now: NOW,
    });
    expect(quoted.strippedCount).toBe(0);
    expect(quoted.text).toBe(answer);
    const first = withPolicy.requests[0]?.messages[0];
    expect(first?.role).toBe('user');
    expect(JSON.stringify(first?.content)).toContain('DATA source=visitor');
    expect(withPolicy.requests[0]?.messages[1]?.role).toBe('assistant');

    const without = scripted([{ text: answer }]);
    const unquoted = await runCase({
      catalog,
      provider: without.provider,
      testCase: caseOf({ textMatches: '15' }, { history }),
      now: NOW,
    });
    expect(unquoted.strippedCount).toBeGreaterThan(0);
  });

  it('turns a provider failure into a turn error that keeps what was spent', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      model: 'flaky',
      async turn() {
        calls += 1;
        if (calls > 1) {
          throw new Error('status 529');
        }
        return {
          text: '',
          toolCalls: [toolCall('search_products', { query: 'tent' })],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 5, outputTokens: 2 },
        };
      },
    };
    const outcome = await runCase({
      catalog,
      provider,
      testCase: caseOf({ hasComponents: true }),
      now: NOW,
    });
    expect(outcome.error).toBe('status 529');
    expect(outcome.modelCalls).toBe(1);
    expect(outcome.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 5,
      outputTokens: 2,
    });
    expect(grade(caseOf({ hasComponents: true }), outcome)).toEqual(['turn error: status 529']);
  });

  it('times out a hung call, aborting its signal', async () => {
    const requests: TurnRequest[] = [];
    const hung: LlmProvider = {
      model: 'hung',
      turn(request) {
        requests.push(request);
        return new Promise(() => {});
      },
    };
    const outcome = await runCase({
      catalog,
      provider: withCallTimeout(hung, 20),
      testCase: caseOf({ hasComponents: true }),
      now: NOW,
    });
    expect(outcome.error).toBe(new CallTimeoutError(20).message);
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('leaves a call that answers in time alone', async () => {
    const { provider } = scripted([{ text: 'Hello.' }]);
    const outcome = await runCase({
      catalog,
      provider: withCallTimeout(provider, 5_000),
      testCase: caseOf({ textMatches: 'hello' }),
      now: NOW,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.text).toBe('Hello.');
  });
});
