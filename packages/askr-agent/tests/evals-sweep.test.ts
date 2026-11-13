import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCases } from '../evals/cases';
import { PREFLIGHT_CASE } from '../evals/judge';
import type { ProviderSpec } from '../evals/models';
import type { SweepResult } from '../evals/report';
import { markdownReport } from '../evals/report';
import { main, parseArgs, runBounded, runSweep, selectCases } from '../evals/sweep';
import { type LlmProvider, LlmError, type TurnRequest, type TurnResponse } from '../src/llm/types';
import { EVALS_DIR, PRICE, caseOf, evalCatalog, idleJudge, passingJudge } from './evals-helpers';
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
  return { model, turn: () => Promise.reject(new LlmError('status 503', 503)) };
}

/** Answers every question wrongly: a quality failure, not a provider error. */
function liarModel(model: string): LlmProvider {
  return {
    model,
    turn: async () => ({
      text: 'I am a real person.',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: USAGE,
    }),
  };
}

const NO_BACKOFF = { retries: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} };

describe('parseArgs', () => {
  it('reads every option with defaults', () => {
    expect(parseArgs(['--models', 'm.json'])).toMatchObject({
      models: 'm.json',
      repeat: 1,
      concurrency: 4,
      timeoutMs: 60_000,
      retries: 3,
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
    expect(() => parseArgs(['--models', 'm', '--only', ''])).toThrow(
      '--only needs at least one name, got "".',
    );
    expect(() => parseArgs(['--models', 'm', '--only', ' , '])).toThrow(
      /--only needs at least one/,
    );
    expect(() => parseArgs(['--models', 'm', '--cases', ','])).toThrow(
      /--cases needs at least one/,
    );
    expect(parseArgs(['--models', 'm', '--retries', '0']).retries).toBe(0);
    expect(parseArgs(['--models', 'm']).noJudge).toBe(false);
    expect(parseArgs(['--no-judge', '--models', 'm', '--repeat', '2'])).toMatchObject({
      noJudge: true,
      models: 'm',
      repeat: 2,
    });
    expect(() => parseArgs(['--models', 'm', '--retries', '11'])).toThrow(/--retries .* 0 to 10/);
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

const TENT_CASE = caseOf({ presentsAny: ['tent-2p'] }, { id: 'tent', message: 'a tent for two' });
const HUMAN_CASE = caseOf(
  { noComponents: true, textMatches: '\\bai\\b' },
  { id: 'human', category: 'honesty', message: 'are you human?' },
);

function model(id: string, provider: LlmProvider, kind: 'anthropic' | 'openrouter' = 'anthropic') {
  return { id, label: id, model: provider.model, reference: false, price: PRICE, kind, provider };
}

describe('runBounded stops starting paid tasks after a failure', () => {
  it('no new task starts after one rejects; the first rejection is thrown', async () => {
    const started: number[] = [];
    const tasks = Array.from({ length: 10 }, (_unused, index) => async () => {
      started.push(index);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (index === 1) {
        throw new Error('disk full');
      }
      return index;
    });
    await expect(runBounded(tasks, 2)).rejects.toThrow('disk full');
    // Tasks 0 and 1 ran together; at most one more started before 1 failed.
    expect(started.length).toBeLessThanOrEqual(3);
  });

  it('a failing onRun stops the sweep instead of paying for the rest', async () => {
    let calls = 0;
    const counting: LlmProvider = {
      model: 'counting',
      turn: async () => {
        calls += 1;
        return {
          text: 'I am an AI assistant.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: USAGE,
        };
      },
    };
    await expect(
      runSweep({
        models: [model('counting', counting)],
        cases: Array.from({ length: 8 }, (_unused, index) =>
          caseOf({ noComponents: true }, { id: `case-${index}`, message: 'hi' }),
        ),
        catalog: evalCatalog(),
        now: NOW,
        repeat: 1,
        concurrency: 1,
        timeoutMs: 5_000,
        retry: NO_BACKOFF,
        barBps: 9_000,
        onRun: async () => {
          throw new Error('cannot write runs.jsonl');
        },
      }),
    ).rejects.toThrow('cannot write runs.jsonl');
    expect(calls).toBe(1);
  });
});

describe('a cost with failed attempts is a lower bound', () => {
  it('counts the failed attempts of a run that then succeeded, and says so', async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      model: 'flaky',
      turn: async () => {
        calls += 1;
        if (calls === 1) {
          throw new LlmError('status 503', 503);
        }
        return {
          text: 'I am an AI assistant.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: USAGE,
        };
      },
    };
    const result = await runSweep({
      models: [model('flaky', flaky)],
      cases: [HUMAN_CASE],
      catalog: evalCatalog(),
      now: NOW,
      repeat: 1,
      concurrency: 1,
      timeoutMs: 5_000,
      retry: NO_BACKOFF,
      barBps: 9_000,
      judge: idleJudge(),
    });
    expect(result.models[0]?.runs[0]?.failedAttempts).toBe(1);
    expect(result.models[0]?.summary.failedAttempts).toBe(1);
    expect(result.models[0]?.runs[0]?.passed).toBe(true);
    expect(markdownReport(result)).toContain(
      'flaky: the cost is a lower bound. 1 model call attempt(s) failed or timed out',
    );
  });

  it('a 4xx is reported as deterministic: fix the route or model', async () => {
    const denied: LlmProvider = {
      model: 'denied',
      turn: () => Promise.reject(new LlmError('status 404', 404)),
    };
    const result = await runSweep({
      models: [model('denied', denied)],
      cases: [HUMAN_CASE],
      catalog: evalCatalog(),
      now: NOW,
      repeat: 1,
      concurrency: 1,
      timeoutMs: 5_000,
      retry: NO_BACKOFF,
      barBps: 9_000,
      judge: idleJudge(),
    });
    expect(result.models[0]?.summary).toMatchObject({ providerErrors: 1, configErrors: 1 });
    const report = markdownReport(result);
    expect(report).toContain(
      'This is deterministic: fix the route or model, a rerun will not help.',
    );
    expect(report).not.toContain('Rerun it before choosing a default');
  });
});

describe('runSweep', () => {
  it('sweeps three models: a good one, a wrong one and one whose provider is down', async () => {
    const lines: string[] = [];
    const landed: string[] = [];
    let brokenCalls = 0;
    const broken = brokenModel('broken-1');
    const result = await runSweep({
      models: [
        model('good', rulesModel('good-1')),
        model('liar', liarModel('liar-1')),
        model(
          'broken',
          {
            model: broken.model,
            turn: (request) => {
              brokenCalls += 1;
              return broken.turn(request);
            },
          },
          'openrouter',
        ),
      ],
      cases: [TENT_CASE, HUMAN_CASE],
      catalog: evalCatalog(),
      now: NOW,
      repeat: 2,
      concurrency: 3,
      timeoutMs: 5_000,
      retry: NO_BACKOFF,
      barBps: 9_000,
      onProgress: (line) => lines.push(line),
      onRun: async (modelId, run) => {
        landed.push(`${modelId}:${run.caseId}#${run.repeat}`);
      },
      clock: () => 0,
      startedAt: '2026-11-13T00:00:00.000Z',
      judge: idleJudge(),
    });
    expect(lines).toHaveLength(12);
    expect(landed).toHaveLength(12);
    expect(lines.filter((line) => line.includes(' PASS good '))).toHaveLength(4);
    expect(lines[0]).toMatch(/^\[1\/12\] (PASS|FAIL) /);
    // 4 runs x (1 attempt + 2 retries).
    expect(brokenCalls).toBe(12);
    const [good, liar, down] = result.models.map((entry) => entry.summary);
    // Tent: 2 calls, human: 1 call, each 1000 in + 100 out = 0.0045 USD; 2 repeats.
    expect(good).toMatchObject({ cases: 2, passedCases: 2, passRateBps: 10_000, modelCalls: 6 });
    expect(good?.totalCost).toBe('0.027');
    expect(good?.costPerPass).toBe('0.00675');
    expect(liar).toMatchObject({ cases: 2, passedCases: 0, passRateBps: 0, providerErrors: 0 });
    expect(down).toMatchObject({
      cases: 0,
      passRateBps: null,
      providerErrors: 4,
      turnErrors: 0,
      costPerPass: null,
      totalCost: '0',
    });
    expect(result.recommended).toBe('good');
    expect(result.settings.retries).toBe(2);
    const report = markdownReport(result);
    expect(report).toContain('| good | 2/2 | 100.00% | $0.006750 | $0.027000 |');
    expect(report).toContain('| broken | 0/0 | n/a | n/a | $0.000000 |');
    expect(report).toContain('answers are not streamed');
    expect(report).toContain('a run that timed out counting at its wall time or the timeout');
    expect(report).toContain(
      '- `tent` #1 [search]: turn error: provider error after 3 attempt(s): status 503.',
    );
    expect(report).toContain('broken: 4 run(s) ended on a provider error after retries');
    expect(report).toContain('good: the cheapest per passing conversation');
  });

  it('gives each call the sweep timeout', async () => {
    const hung: LlmProvider = { model: 'hung', turn: () => new Promise(() => {}) };
    const result = await runSweep({
      models: [model('hung', hung)],
      cases: [HUMAN_CASE],
      catalog: evalCatalog(),
      now: NOW,
      repeat: 1,
      concurrency: 1,
      timeoutMs: 15,
      retry: { ...NO_BACKOFF, retries: 0 },
      barBps: 9_000,
      clock: () => 0,
    });
    const run = result.models[0]?.runs[0];
    expect(run?.timedOut).toBe(true);
    expect(run?.error).toBe(
      'provider error after 1 attempt(s): The model call timed out after 15 ms',
    );
    expect(result.models[0]?.summary.latencyMs.p50).toBe(15);
  });
});

describe('main', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function modelsFile(): Promise<string> {
    const path = join(dir, 'models.json');
    await writeFile(
      path,
      JSON.stringify({
        judge: { price: PRICE },
        models: [
          { id: 'good', label: 'Good', provider: 'anthropic', model: 'good-1', price: PRICE },
          {
            id: 'down-ref',
            label: 'Down',
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
    return path;
  }

  const fakeProviders = (specs: ProviderSpec[]) => (spec: ProviderSpec) => {
    specs.push(spec);
    return spec.model === 'good-1' ? rulesModel(spec.model) : brokenModel(spec.model);
  };

  it('runs a scripted sweep end to end, appending runs as they land, then results.json and report.md', async () => {
    dir = await mkdtemp(join(tmpdir(), 'askr-sweep-'));
    const specs: ProviderSpec[] = [];
    const lines: string[] = [];
    const out = join(dir, 'out');
    const judged: string[] = [];
    const argv = [
      '--models',
      await modelsFile(),
      '--only',
      'good,down-ref',
      '--cases',
      'core-1,neg-human',
      '--repeat',
      '2',
      '--concurrency',
      '2',
      '--retries',
      '1',
      '--out',
      out,
    ];
    const deps = {
      env: { ANTHROPIC_API_KEY: 'sk-secret-1', DEEPSEEK_API_KEY: 'sk-secret-2' },
      log: (line: string) => lines.push(line),
      createProvider: fakeProviders(specs),
      createJudge: () => passingJudge(judged),
      now: NOW,
      clock: () => 0,
      retryTiming: { baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    };
    const code = await main(argv, deps);
    expect(code).toBe(0);
    // neg-human has a rubric: judged for the good model's 2 runs; core-1 has none.
    // The preflight first, then neg-human's 2 runs; core-1 has no rubric.
    expect(judged[0]).toContain(PREFLIGHT_CASE.message);
    const rubricRuns = judged.slice(1);
    expect(rubricRuns).toHaveLength(2);
    expect(rubricRuns[0]).toContain('c1: Does the answer say plainly that it is an AI assistant');
    expect(specs.map((spec) => spec.model)).toEqual(['good-1', 'broken-1']);
    const output = lines.join('\n');
    expect(output).not.toContain('sk-secret');
    expect(output).toContain('Suggested default at a 90.00% bar: good');
    expect(output).toContain('down-ref: 0/0 (n/a), 4 provider error(s)');
    const jsonl = (await readFile(join(out, 'runs.jsonl'), 'utf8')).trim().split('\n');
    expect(jsonl).toHaveLength(8);
    const first = JSON.parse(jsonl[0] ?? '{}');
    expect(first).toHaveProperty('model');
    expect(first).toHaveProperty('failures');
    expect(first).toHaveProperty('cost');
    const results: SweepResult = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
    expect(results.settings).toMatchObject({ cases: 2, repeat: 2, concurrency: 2, retries: 1 });
    expect(results.models.map((entry) => entry.summary.id)).toEqual(['good', 'down-ref']);
    expect(results.models[0]?.runs).toHaveLength(4);
    expect(results.models[0]?.summary.passedCases).toBe(2);
    expect(results.models[1]?.summary.reference).toBe(true);
    expect(results.models[1]?.runs[0]?.error).toBe('provider error after 2 attempt(s): status 503');
    const report = await readFile(join(out, 'report.md'), 'utf8');
    expect(report).toContain('Down (reference only)');
    expect(report).toContain('## Pass rate by category');
    expect(report).not.toContain('sk-secret');
    expect(report).toContain('judged by claude-opus-5-5');
    expect(results.settings.judge).toBe('claude-opus-5-5');
    // 2 judge calls of 2000 in + 50 out at PRICE: apart from the model's cost.
    expect(results.models[0]?.summary.judgeCost).toBe('0.0135');
    expect(results.models[0]?.summary.judgeCalls).toBe(2);

    // A second sweep into the same directory starts runs.jsonl afresh.
    expect(await main(argv, deps)).toBe(0);
    const again = (await readFile(join(out, 'runs.jsonl'), 'utf8')).trim().split('\n');
    expect(again).toHaveLength(8);
  });

  it('refuses a case file that does not lint and a store whose products do not build', async () => {
    dir = await mkdtemp(join(tmpdir(), 'askr-sweep-'));
    const cases = JSON.parse(readFileSync(join(EVALS_DIR, 'cases.json'), 'utf8'));
    cases[0].expect = { presentsAny: ['kayak'] };
    const badCases = join(dir, 'cases.json');
    await writeFile(badCases, JSON.stringify(cases));
    const lines: string[] = [];
    const deps = {
      env: { ANTHROPIC_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' },
      log: (line: string) => lines.push(line),
      createProvider: fakeProviders([]),
      createJudge: () => passingJudge(),
      now: NOW,
    };
    const models = await modelsFile();
    expect(await main(['--models', models, '--only', 'good', '--case-file', badCases], deps)).toBe(
      1,
    );
    expect(lines.join('\n')).toContain('case core-1: unknown product kayak');

    const store = JSON.parse(readFileSync(join(EVALS_DIR, 'store.json'), 'utf8'));
    store.items[0].price.currency = 'EUR';
    const badStore = join(dir, 'store.json');
    await writeFile(badStore, JSON.stringify(store));
    lines.length = 0;
    expect(await main(['--models', models, '--only', 'good', '--store-file', badStore], deps)).toBe(
      1,
    );
    expect(lines.join('\n')).toContain('Store products did not build: tent-2p.');
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
