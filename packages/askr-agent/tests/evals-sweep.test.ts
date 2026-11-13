import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCases } from '../evals/cases';
import type { ProviderSpec } from '../evals/models';
import type { SweepResult } from '../evals/report';
import { markdownReport } from '../evals/report';
import { main, parseArgs, runBounded, runSweep, selectCases } from '../evals/sweep';
import type { LlmProvider, TurnRequest, TurnResponse } from '../src/llm/types';
import { EVALS_DIR, PRICE, caseOf, evalCatalog } from './evals-helpers';
import { NOW, toolCall } from './fixtures';

const USAGE = { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };

/** A rule-based fake model: presents the tent the visitor asked about, says it is an AI otherwise. */
function rulesModel(model: string): LlmProvider {
  return {
    model,
    async turn(request: TurnRequest): Promise<TurnResponse> {
      const last = request.messages.at(-1);
      const afterTool = last?.content.some((block) => block.type === 'tool_result') ?? false;
      const visitor = JSON.stringify(request.messages[0]?.content ?? []).toLowerCase();
      if (!afterTool && visitor.includes('tent')) {
        return {
          text: '',
          toolCalls: [toolCall('present_products', { picks: [{ id: 'tent-2p' }] })],
          stopReason: 'tool_use',
          usage: USAGE,
        };
      }
      return {
        text: visitor.includes('tent') ? 'The Ridge fits two.' : 'I am an AI assistant.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: USAGE,
      };
    },
  };
}

function brokenModel(model: string): LlmProvider {
  return { model, turn: () => Promise.reject(new Error('status 503')) };
}

describe('parseArgs', () => {
  it('reads every option with defaults', () => {
    expect(parseArgs(['--models', 'm.json'])).toMatchObject({
      models: 'm.json',
      repeat: 1,
      concurrency: 4,
      timeoutMs: 60_000,
      barBps: 9_000,
    });
    expect(
      parseArgs([
        '--models',
        'm.json',
        '--only',
        'a, b',
        '--cases',
        'core-1,search',
        '--repeat',
        '3',
        '--concurrency',
        '2',
        '--timeout',
        '5',
        '--bar',
        '95',
        '--out',
        'out',
      ]),
    ).toMatchObject({
      only: ['a', 'b'],
      cases: ['core-1', 'search'],
      repeat: 3,
      concurrency: 2,
      timeoutMs: 5_000,
      barBps: 9_500,
      out: 'out',
    });
  });

  it('refuses a missing --models, an unknown flag, a missing value and bad numbers', () => {
    expect(() => parseArgs([])).toThrow(/--models is required/);
    expect(() => parseArgs(['--models', 'm', '--model', 'x'])).toThrow(/Unknown option "--model"/);
    expect(() => parseArgs(['--models', 'm', '--repeat'])).toThrow(/--repeat needs a value/);
    expect(() => parseArgs(['--models', 'm', '--repeat', '0'])).toThrow(/whole number from 1/);
    expect(() => parseArgs(['--models', 'm', '--concurrency', '1.5'])).toThrow(/whole number/);
    expect(() => parseArgs(['--models', 'm', '--concurrency', '99'])).toThrow(/to 32/);
  });
});

describe('selectCases', () => {
  const cases = parseCases([
    { id: 'core-1', category: 'search', message: 'x', expect: { hasComponents: true } },
    { id: 'core-2', category: 'cheapest', message: 'x', expect: { hasComponents: true } },
    { id: 'neg-human', category: 'honesty', message: 'x', expect: { noComponents: true } },
  ]);

  it('filters by id, category and prefix', () => {
    const ids = (filters?: string[]) => selectCases(cases, filters).map((testCase) => testCase.id);
    expect(ids()).toEqual(['core-1', 'core-2', 'neg-human']);
    expect(ids(['core-2', 'honesty'])).toEqual(['core-2', 'neg-human']);
    expect(ids(['core-*'])).toEqual(['core-1', 'core-2']);
    expect(() => ids(['nothing'])).toThrow('--cases nothing matches no case.');
  });
});

describe('runBounded', () => {
  it('never has more than the limit in flight and keeps the order', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_unused, index) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return index;
    });
    expect(await runBounded(tasks, 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(3);
  });
});

describe('runSweep', () => {
  it('sweeps two models and reports pass rates, costs and the suggested default', async () => {
    const lines: string[] = [];
    const result = await runSweep({
      models: [
        {
          id: 'good',
          label: 'Good',
          model: 'good-1',
          reference: false,
          price: PRICE,
          kind: 'anthropic',
          provider: rulesModel('good-1'),
        },
        {
          id: 'broken',
          label: 'Broken',
          model: 'broken-1',
          reference: false,
          price: PRICE,
          kind: 'openrouter',
          provider: brokenModel('broken-1'),
        },
      ],
      cases: [
        caseOf({ presentsAny: ['tent-2p'] }, { id: 'tent', message: 'a tent for two' }),
        caseOf(
          { noComponents: true, textMatches: '\\bai\\b' },
          { id: 'human', category: 'honesty', message: 'are you human?' },
        ),
      ],
      catalog: evalCatalog(),
      now: NOW,
      repeat: 2,
      concurrency: 3,
      timeoutMs: 5_000,
      barBps: 9_000,
      onProgress: (line) => lines.push(line),
      clock: () => 0,
      startedAt: '2026-11-13T00:00:00.000Z',
    });
    expect(lines).toHaveLength(8);
    expect(lines.filter((line) => line.includes(' PASS good '))).toHaveLength(4);
    expect(lines.filter((line) => line.includes(' FAIL broken '))).toHaveLength(4);
    expect(lines[0]).toMatch(/^\[1\/8\] (PASS|FAIL) /);
    const [good, broken] = result.models.map((model) => model.summary);
    // Tent: 2 calls, human: 1 call, each 1000 in + 100 out = 0.0045 USD; 2 repeats.
    expect(good).toMatchObject({ cases: 2, passedCases: 2, passRateBps: 10_000, modelCalls: 6 });
    expect(good?.totalCost).toBe('0.027');
    expect(good?.costPerPass).toBe('0.00675');
    expect(broken).toMatchObject({
      passedCases: 0,
      turnErrors: 4,
      costPerPass: null,
      totalCost: '0',
    });
    expect(result.recommended).toBe('good');
    const report = markdownReport(result);
    expect(report).toContain('| Good | 2/2 | 100.00% | $0.006750 | $0.027000 |');
    expect(report).toContain('| Broken | 0/2 | 0.00% | n/a | $0.000000 |');
    expect(report).toContain('answers are not streamed');
    expect(report).toContain('- `tent` #1 [search]: turn error: status 503.');
    expect(report).toContain('Good: the cheapest per passing conversation');
  });
});

describe('main', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs a scripted sweep end to end and writes results.json and report.md', async () => {
    dir = await mkdtemp(join(tmpdir(), 'askr-sweep-'));
    const modelsFile = join(dir, 'models.json');
    await writeFile(
      modelsFile,
      JSON.stringify({
        models: [
          { id: 'good', label: 'Good', provider: 'anthropic', model: 'good-1', price: PRICE },
          {
            id: 'flaky-ref',
            label: 'Flaky',
            provider: 'deepseek',
            model: 'broken-1',
            reference: true,
            price: PRICE,
          },
          {
            id: 'skipped',
            label: 'Skipped',
            provider: 'anthropic',
            model: 'x',
            price: { input: '', cachedInput: '', cacheWrite: '', output: '' },
          },
        ],
      }),
    );
    const specs: ProviderSpec[] = [];
    const lines: string[] = [];
    const out = join(dir, 'out');
    const code = await main(
      [
        '--models',
        modelsFile,
        '--only',
        'good,flaky-ref',
        '--cases',
        'core-1,neg-human',
        '--repeat',
        '2',
        '--concurrency',
        '2',
        '--out',
        out,
      ],
      {
        env: { ANTHROPIC_API_KEY: 'sk-secret-1', DEEPSEEK_API_KEY: 'sk-secret-2' },
        log: (line) => lines.push(line),
        createProvider: (spec) => {
          specs.push(spec);
          return spec.model === 'good-1' ? rulesModel(spec.model) : brokenModel(spec.model);
        },
        now: NOW,
        clock: () => 0,
      },
    );
    expect(code).toBe(0);
    expect(specs.map((spec) => spec.model)).toEqual(['good-1', 'broken-1']);
    const output = lines.join('\n');
    expect(output).not.toContain('sk-secret');
    expect(output).toContain('Suggested default at a 90.00% bar: good');
    const results: SweepResult = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
    expect(results.settings).toMatchObject({ cases: 2, repeat: 2, concurrency: 2 });
    expect(results.models.map((model) => model.summary.id)).toEqual(['good', 'flaky-ref']);
    expect(results.models[0]?.runs).toHaveLength(4);
    expect(results.models[0]?.summary.passedCases).toBe(2);
    expect(results.models[1]?.summary.reference).toBe(true);
    const report = await readFile(join(out, 'report.md'), 'utf8');
    expect(report).toContain('Flaky (reference only)');
    expect(report).toContain('## Pass rate by category');
    expect(report).not.toContain('sk-secret');
  });

  it('exits 2 on bad arguments and 1 on a refused models file, saying why', async () => {
    const lines: string[] = [];
    expect(await main([], { env: {}, log: (line) => lines.push(line) })).toBe(2);
    expect(lines.join('\n')).toContain('--models is required');
    lines.length = 0;
    const code = await main(['--models', join(EVALS_DIR, 'models.example.json')], {
      env: {},
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('price.input is empty');
  });
});
