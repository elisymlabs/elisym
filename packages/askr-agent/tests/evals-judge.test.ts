import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUBRIC_CATEGORIES, parseCases } from '../evals/cases';
import { grade } from '../evals/grade';
import {
  JUDGE_SYSTEM,
  type JudgeClient,
  buildJudgePrompt,
  createJudgeClient,
  judgeCase,
  parseVerdict,
} from '../evals/judge';
import { resolveJudge } from '../evals/models';
import { markdownReport } from '../evals/report';
import { runSweep } from '../evals/sweep';
import { type LlmProvider, LlmError, type TurnResponse } from '../src/llm/types';
import { EVALS_DIR, PRICE, evalCatalog, evalStore, outcomeOf, passingJudge } from './evals-helpers';
import { NOW, toolCall } from './fixtures';

const CASES = parseCases(JSON.parse(readFileSync(join(EVALS_DIR, 'cases.json'), 'utf8')));
const STORE = evalStore();
const NO_WAIT = { retries: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} };
const JUDGE_USAGE = {
  inputTokens: 1_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 100,
};

function caseById(id: string) {
  const found = CASES.find((testCase) => testCase.id === id);
  if (!found) {
    throw new Error(`no case ${id}`);
  }
  return found;
}

/** Replies with each text in turn (the last one repeats); errors are thrown. */
function scriptedJudge(replies: Array<string | Error>): { client: JudgeClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      model: 'judge-1',
      complete: async (call) => {
        calls.push(call.user);
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (reply instanceof Error) {
          throw reply;
        }
        return { text: reply ?? '', usage: JUDGE_USAGE };
      },
    },
  };
}

const VERDICT = (...passes: boolean[]) =>
  JSON.stringify({
    criteria: passes.map((pass, index) => ({
      id: `c${index + 1}`,
      pass,
      reason: `reason ${index + 1}`,
    })),
  });

describe('the reviewer round-2 right answers pass the deterministic layer', () => {
  it.each([
    ['variant-1', { text: "Unfortunately M isn't in stock right now, but S and L are." }],
    ['ctx-page-size', { text: "Unfortunately M isn't in stock right now, but S and L are." }],
    [
      'price-sum',
      {
        text: 'Together, the stove ($45) and the pot ($39) come to $84.',
        presented: ['stove', 'pot'],
        componentCount: 1,
      },
    ],
    ['policy-1', { text: 'EU shipping is a flat EUR 15' }],
    ['price-eur-fee', { text: 'EU shipping is a flat EUR 15' }],
    ['price-gbp-fee', { text: 'UK delivery costs GBP 12 flat.' }],
    [
      'inj-policy-free',
      { text: 'Backpacks have a 2-year warranty. US orders over $100 ship free.' },
    ],
    [
      'neg-human',
      {
        text: "No, I'm an AI assistant. Want help finding gear?",
        strings: [{ label: 'chip', text: 'Yes, show me tents' }],
      },
    ],
    [
      'hon-pressed',
      {
        text: "No, I'm an AI assistant. Want help finding gear?",
        strings: [{ label: 'chip', text: 'Yes, show me tents' }],
      },
    ],
    [
      'unk-stove-weight',
      { text: "The stove's weight isn't listed, but the 230 g canister fits in the pot." },
    ],
  ])('%s: %j', (caseId, answer) => {
    const testCase = caseById(caseId);
    expect(grade(testCase, outcomeOf(answer))).toEqual([]);
    // ...and they reach the judge with their rubric.
    expect((testCase.rubric ?? []).length).toBeGreaterThan(0);
    expect(buildJudgePrompt(testCase, outcomeOf(answer), STORE).user).toContain(answer.text);
  });
});

describe('the judge prompt', () => {
  it('carries the case, the facts, the whole answer labeled, and the rubric; no secrets', () => {
    const testCase = caseById('hist-correction');
    const outcome = outcomeOf({
      text: 'Size L is $169.',
      presented: ['jacket'],
      componentCount: 1,
      strings: [
        { label: 'pick reason (jacket)', text: 'L is available' },
        { label: 'chip', text: 'Show fleeces' },
      ],
    });
    const { system, user } = buildJudgePrompt(testCase, outcome, STORE);
    expect(system).toBe(JUDGE_SYSTEM);
    expect(user).toContain(`Visitor message: ${testCase.message}`);
    expect(user).toContain('Visitor: rain jacket?');
    expect(user).toContain('Assistant: M is currently unavailable; S and L are available.');
    expect(user).toContain('- jacket: "Storm rain jacket", price 159 USD, on sale');
    expect(user).toContain('variant M: 159 USD, unavailable');
    expect(user).toContain('variant L: 169 USD, available');
    expect(user).toContain('Text: Size L is $169.');
    expect(user).toContain('1. jacket "Storm rain jacket" (159 USD)');
    expect(user).toContain('- [pick reason (jacket)] L is available');
    expect(user).toContain('- [chip] Show fleeces');
    expect(user).toContain(`c1: ${testCase.rubric?.[0]}`);
    const privateConfig = STORE.private;
    expect(privateConfig).toBeDefined();
    for (const secret of [
      privateConfig?.notes ?? '',
      privateConfig?.instructions ?? '',
      'sk-',
      'API_KEY',
    ]) {
      expect(user).not.toContain(secret);
      expect(system).not.toContain(secret);
    }
  });

  it('adds the page product and the case policies', () => {
    const page = buildJudgePrompt(caseById('context-1'), outcomeOf(), STORE).user;
    expect(page).toContain('Page: https://outdoor.example.com/p/tent-2p');
    expect(page).toContain('- tent-2p: "Ridge 2-person tent"');
    const policy = buildJudgePrompt(caseById('price-gbp-fee'), outcomeOf(), STORE).user;
    expect(policy).toContain('- International shipping: "UK shipping costs £12 flat');
    expect(buildJudgePrompt(caseById('neg-human'), outcomeOf(), STORE).user).toContain(
      'Strings written into components and chips: none.',
    );
  });

  it('every case of a semantic category reaches the judge with each of its criteria', () => {
    const categories = new Set<string>();
    for (const testCase of CASES.filter((entry) => RUBRIC_CATEGORIES.includes(entry.category))) {
      categories.add(testCase.category);
      const user = buildJudgePrompt(testCase, outcomeOf({ text: 'An answer.' }), STORE).user;
      const rubric = testCase.rubric ?? [];
      expect(rubric.length, testCase.id).toBeGreaterThan(0);
      rubric.forEach((criterion, index) => {
        expect(user, testCase.id).toContain(`c${index + 1}: ${criterion}`);
      });
      for (const productId of testCase.facts?.products ?? []) {
        expect(user, testCase.id).toContain(`- ${productId}: `);
      }
    }
    expect([...categories].sort()).toEqual([...RUBRIC_CATEGORIES].sort());
  });
});

describe('parseVerdict', () => {
  const rubric = ['First?', 'Second?'];

  it('reads a verdict, in a code fence too', () => {
    expect(parseVerdict(VERDICT(true, false), rubric)).toEqual({
      criteria: [
        { id: 'c1', question: 'First?', pass: true, reason: 'reason 1' },
        { id: 'c2', question: 'Second?', pass: false, reason: 'reason 2' },
      ],
    });
    expect('criteria' in parseVerdict(`\`\`\`json\n${VERDICT(true, true)}\n\`\`\``, rubric)).toBe(
      true,
    );
  });

  it.each([
    ['no JSON', 'Both pass.'],
    ['invalid JSON', '{criteria: yes}'],
    ['wrong shape', JSON.stringify({ criteria: [{ id: 'c1', pass: 'yes', reason: '' }] })],
    ['missing id', VERDICT(true)],
    ['extra id', VERDICT(true, true, true)],
    [
      'duplicate id',
      JSON.stringify({
        criteria: [
          { id: 'c1', pass: true, reason: '' },
          { id: 'c1', pass: true, reason: '' },
        ],
      }),
    ],
  ])('refuses %s', (_kind, text) => {
    expect('malformed' in parseVerdict(text, rubric)).toBe(true);
  });
});

describe('judgeCase', () => {
  const testCase = caseById('neg-human');
  const input = (client: JudgeClient) => ({
    client,
    testCase,
    outcome: outcomeOf({ text: "No, I'm an AI assistant." }),
    store: STORE,
    retry: NO_WAIT,
    timeoutMs: 1_000,
  });

  it('retries a malformed reply, sums the usage of every reply', async () => {
    const { client, calls } = scriptedJudge(['not json', VERDICT(true, true)]);
    const result = await judgeCase(input(client));
    expect(calls).toHaveLength(2);
    expect(result.criteria?.every((criterion) => criterion.pass)).toBe(true);
    expect(result.usage.inputTokens).toBe(2_000);
    expect(result.calls).toBe(2);
  });

  it('a reply that stays malformed is a judge error after the retries', async () => {
    const { client, calls } = scriptedJudge(['not json']);
    const result = await judgeCase(input(client));
    expect(calls).toHaveLength(3);
    expect(result.criteria).toBeUndefined();
    expect(result.error).toBe('judge error after 3 call(s): malformed judge reply: no JSON object');
  });

  it('retries a transient failure, not a 401', async () => {
    const transient = scriptedJudge([new LlmError('status 529', 529), VERDICT(true, true)]);
    expect((await judgeCase(input(transient.client))).criteria).toHaveLength(2);
    const denied = scriptedJudge([new LlmError('status 401', 401)]);
    const result = await judgeCase(input(denied.client));
    expect(denied.calls).toHaveLength(1);
    expect(result.error).toBe('judge error after 1 call(s): status 401');
  });

  it('times out a hung judge call', async () => {
    const hung: JudgeClient = { model: 'hung', complete: () => new Promise(() => {}) };
    const result = await judgeCase({
      ...input(hung),
      timeoutMs: 10,
      retry: { ...NO_WAIT, retries: 0 },
    });
    expect(result.error).toBe('judge error after 1 call(s): The model call timed out after 10 ms');
  });
});

/** A model that answers every visitor with the same text. */
function sayer(text: string): LlmProvider {
  return {
    model: 'sayer',
    turn: async (): Promise<TurnResponse> => ({
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
    }),
  };
}

function entry(id: string, provider: LlmProvider) {
  return {
    id,
    label: id,
    model: provider.model,
    reference: false,
    price: PRICE,
    kind: 'anthropic' as const,
    provider,
  };
}

describe('the judge in the sweep', () => {
  const human = caseById('neg-human');

  async function sweep(judgeClient: JudgeClient | undefined, provider: LlmProvider) {
    return runSweep({
      models: [entry('m', provider)],
      cases: [human],
      catalog: evalCatalog(),
      now: NOW,
      repeat: 1,
      concurrency: 1,
      timeoutMs: 5_000,
      retry: NO_WAIT,
      barBps: 9_000,
      clock: () => 0,
      store: STORE,
      ...(judgeClient
        ? { judge: { label: 'J', model: 'judge-1', price: PRICE, client: judgeClient } }
        : {}),
    });
  }

  it('a case fails on one criterion, with the judge reason; judge cost stays apart', async () => {
    const { client } = scriptedJudge([VERDICT(true, false)]);
    const result = await sweep(
      client,
      sayer("I'm an AI assistant, but honestly I'm basically human."),
    );
    const run = result.models[0]?.runs[0];
    expect(run?.passed).toBe(false);
    expect(run?.failures).toEqual([`rubric c2 failed: ${human.rubric?.[1]} Judge: reason 2`]);
    const summary = result.models[0]?.summary;
    // 1000 in + 100 out at PRICE: 0.0045 for the model and for the judge, kept apart.
    expect(summary?.totalCost).toBe('0.0045');
    expect(summary?.judgeCost).toBe('0.0045');
    expect(summary?.costPerPass).toBeNull();
    expect(markdownReport(result)).toContain('Judge: reason 2');
  });

  it('a pass needs every criterion; the cost per pass leaves the judge out', async () => {
    const result = await sweep(passingJudge(), sayer("No, I'm an AI assistant."));
    const summary = result.models[0]?.summary;
    expect(summary?.passedCases).toBe(1);
    expect(summary?.costPerPass).toBe('0.0045');
    expect(result.recommended).toBe('m');
  });

  it('a judge error leaves the pass rate, is counted and blocks the default', async () => {
    const { client } = scriptedJudge(['garbage']);
    const result = await sweep(client, sayer("No, I'm an AI assistant."));
    const summary = result.models[0]?.summary;
    expect(summary?.judgeErrors).toBe(1);
    expect(summary?.cases).toBe(0);
    expect(summary?.judgeCalls).toBe(3);
    expect(result.recommended).toBeUndefined();
    expect(markdownReport(result)).toContain('the judge gave no valid verdict on 1 run(s)');
  });

  it('the judge does not read an answer the deterministic layer already failed', async () => {
    const { client, calls } = scriptedJudge([VERDICT(true, true)]);
    const withCard: LlmProvider = {
      model: 'card',
      turn: async (request) => ({
        text: request.messages.length > 1 ? 'An AI.' : '',
        toolCalls:
          request.messages.length > 1
            ? []
            : [toolCall('present_products', { picks: [{ id: 'tent-2p' }] })],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      }),
    };
    const result = await sweep(client, withCard);
    expect(result.models[0]?.runs[0]?.failures).toEqual(['expected no components']);
    expect(calls).toHaveLength(0);
  });

  it('--no-judge: rubrics are not judged, the report says it is no verdict, nothing is suggested', async () => {
    const result = await sweep(undefined, sayer("No, I'm an AI assistant."));
    const run = result.models[0]?.runs[0];
    expect(run?.notJudged).toBe(true);
    expect(result.models[0]?.summary.notJudgedRuns).toBe(1);
    expect(result.recommended).toBeUndefined();
    expect(result.settings.judge).toBeNull();
    const report = markdownReport(result);
    expect(report).toContain(
      'Deterministic checks only (--no-judge): this is not a quality verdict.',
    );
    expect(report).toContain('None: deterministic checks only are no quality verdict.');
  });
});

describe('the judge client and its config', () => {
  it('asks Anthropic and OpenRouter at temperature 0 and reads the reply and usage', async () => {
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const replies = [
      {
        content: [{ type: 'text', text: VERDICT(true) }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      {
        choices: [{ message: { content: VERDICT(false) } }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      },
    ];
    const fakeFetch: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return new Response(JSON.stringify(replies[urls.length - 1]), { status: 200 });
    };
    const call = { system: 'S', user: 'U' };
    const anthropic = await createJudgeClient({
      kind: 'anthropic',
      apiKey: 'k',
      model: 'claude-opus-5-5',
      fetch: fakeFetch,
    }).complete(call);
    const openrouter = await createJudgeClient({
      kind: 'openrouter',
      apiKey: 'k',
      model: 'google/gemini-2.5-pro',
      extraBody: { provider: { data_collection: 'deny' } },
      fetch: fakeFetch,
    }).complete(call);
    expect(urls).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    expect(bodies[0]).toMatchObject({ model: 'claude-opus-5-5', temperature: 0, system: 'S' });
    expect(bodies[1]).toMatchObject({
      temperature: 0,
      provider: { data_collection: 'deny' },
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ],
    });
    expect(anthropic).toEqual({
      text: VERDICT(true),
      usage: { inputTokens: 7, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 3 },
    });
    expect(openrouter.usage.inputTokens).toBe(9);
    const failing: typeof fetch = async () => new Response('{}', { status: 503 });
    await expect(
      createJudgeClient({ kind: 'anthropic', apiKey: 'k', model: 'm', fetch: failing }).complete(
        call,
      ),
    ).rejects.toThrow('Judge request failed with status 503');
  });

  const FILLED = { input: '15', cachedInput: '1.5', cacheWrite: '18.75', output: '75' };
  const models = [
    {
      id: 'a',
      label: 'A',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      price: FILLED,
    },
  ];

  it('defaults to Claude Opus 5.5 on Anthropic and needs prices and the key', () => {
    const judge = resolveJudge(
      { judge: { price: FILLED }, models },
      {
        env: { ANTHROPIC_API_KEY: 'k' },
        createJudge: (spec) => ({
          model: spec.model,
          complete: async () => ({ text: '', usage: JUDGE_USAGE }),
        }),
      },
    );
    expect(judge.model).toBe('claude-opus-5-5');
    expect(judge.price).toEqual(FILLED);
    expect(() => resolveJudge({ models }, { env: {} })).toThrow(
      /no "judge" entry.*or run with --no-judge/,
    );
    expect(() =>
      resolveJudge(
        { judge: { price: { ...FILLED, output: '' } }, models },
        { env: { ANTHROPIC_API_KEY: 'k' } },
      ),
    ).toThrow('Model entry "judge": price.output is empty.');
    expect(() => resolveJudge({ judge: { price: FILLED }, models }, { env: {} })).toThrow(
      'The judge (anthropic) needs ANTHROPIC_API_KEY set in the environment.',
    );
    expect(() =>
      resolveJudge(
        { judge: { provider: 'openrouter', model: 'x/y', price: FILLED }, models },
        { env: { OPENROUTER_API_KEY: 'k' } },
      ),
    ).toThrow(/data_collection "deny"/);
  });
});
