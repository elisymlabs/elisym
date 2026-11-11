import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/llm/anthropic';
import { createOpenAiCompatibleProvider } from '../src/llm/openai-compatible';
import type { LlmProvider, TurnRequest } from '../src/llm/types';
import { checkPrices, extractAmounts, stripViolations } from '../src/price-check';
import { estimateTokens } from '../src/prompt';
import { sanitizeAnswerText } from '../src/text-sanitize';
import { executeTool, newTurnState } from '../src/tools';
import { TurnError, runTurn } from '../src/turn';
import { CATALOG_KEY, NOW, catalog, scripted, toolCall } from './fixtures';

const store = catalog();
const address = (d: string) => `30402:${CATALOG_KEY}:${d}`;
const context = (visitor: string[] = [], policies: string[] = []) => ({
  storeCurrency: 'USD',
  items: store.items,
  visitorMessages: visitor,
  policyPassages: policies,
  locales: ['en'],
});
const answer = (text: string, overrides: Partial<Answer> = {}): Answer => ({
  type: 'answer',
  ask_id: '0'.repeat(32),
  session_end: 1,
  text,
  components: [],
  chips: [],
  ...overrides,
});
const input = (provider: LlmProvider) => ({
  catalog: store,
  provider,
  history: [],
  askId: 'a'.repeat(32),
  text: 'show me jackets under $130',
  sessionEnd: NOW + 60,
  now: NOW,
  earlierVisitorMessages: [],
  earlierPolicyPassages: [],
});

describe('1. the corrective re-run keeps what the first loop earned', () => {
  it('keeps ids returned before the re-run presentable after it', async () => {
    const { provider } = scripted([
      { calls: [toolCall('present_products', { picks: [{ id: 'jacket-wool' }] })] },
      { text: 'Now $99.' },
      { calls: [toolCall('present_products', { picks: [{ id: 'jacket-wool' }] })] },
      { text: 'Here it is.' },
    ]);
    const output = await runTurn(input(provider));
    expect(output.answer.components).toHaveLength(1);
    expect(output.allowedIds).toContain('jacket-wool');
  });
});

describe('2. titles and dimensions are price-checked', () => {
  it('flags an invented price in a products title and a comparison dimension', () => {
    const bad = answer('', {
      components: [
        {
          type: 'products',
          title: 'Wool jacket now $9',
          picks: [{ address: address('jacket-wool') }],
        },
        {
          type: 'comparison',
          addresses: [address('jacket-wool'), address('jacket-rain')],
          rows: [
            { dimension: 'Price', cells: ['120 USD', '79.9 USD'] },
            { dimension: 'Sale $99', cells: ['a', 'b'] },
          ],
        },
      ],
    });
    const violations = checkPrices(bad, context());
    expect(violations.map((violation) => violation.where)).toEqual([
      'component#0.title',
      'component#1.row#1.dimension',
    ]);
    const stripped = stripViolations(bad, violations);
    const [products, comparison] = stripped.components;
    expect(products && 'title' in products).toBe(false);
    expect(
      comparison?.type === 'comparison' && comparison.rows.map((row) => row.dimension),
    ).toEqual(['Price']);
  });
});

describe('3. product mentions come from the whole catalog', () => {
  it('fails "the Rain jacket is $80" even when the visitor said $80', () => {
    expect(checkPrices(answer('The Rain jacket is $80.'), context(['about $80']))).toHaveLength(1);
  });

  it("passes a named product's true price without a card", () => {
    expect(checkPrices(answer('The Rain jacket is $79.90.'), context())).toEqual([]);
  });

  it('passes the visitor amount only with no other amount in the sentence', () => {
    expect(
      checkPrices(answer('Under $130 there are good options.'), context(['under $130'])),
    ).toEqual([]);
    expect(
      checkPrices(answer('Under $130 or $140 there are options.'), context(['under $130'])),
    ).toHaveLength(1);
  });

  it('passes a policy amount returned this session', () => {
    expect(checkPrices(answer('EU shipping is €15.'), context([], ['EU shipping €15.']))).toEqual(
      [],
    );
  });
});

describe('5. links and images cannot survive the sanitizer', () => {
  it('neutralizes every bracket form', () => {
    for (const attack of [
      '[a [b] c](http://evil.x)',
      '[a\\]b](http://evil.x)',
      '![x [y]](http://evil/p.png)',
      '> [r]: http://evil\n[click][r]',
      '<scr<script>ipt>',
    ]) {
      expect(sanitizeAnswerText(attack)).not.toMatch(/[[\]<>]/);
    }
  });
});

describe('6-7. amount grammar and currency detection', () => {
  it('does not read across a comma and a space', () => {
    expect(
      extractAmounts('Under $120, 3 colors', ['en']).map((amount) => amount.values[0]?.toString()),
    ).toEqual(['120']);
    expect(
      checkPrices(
        answer('', {
          components: [
            {
              type: 'products',
              picks: [{ address: address('jacket-wool'), reason: 'Under $120, 3 colors' }],
            },
          ],
        }),
        context(['under $120']),
      ),
    ).toHaveLength(0);
  });

  it('reads lowercase codes and currency words, skips code-words without decimals', () => {
    expect(extractAmounts('99 usd', ['en'])[0]?.currencies).toEqual(['USD']);
    expect(extractAmounts('99 dollars', ['en'])[0]?.currencies).toContain('USD');
    expect(extractAmounts('99 euros', ['en'])[0]?.currencies).toEqual(['EUR']);
    expect(extractAmounts('99 рублей', ['ru'])[0]?.currencies).toEqual(['RUB']);
    expect(extractAmounts('TOP 5 picks and ALL 3 sizes', ['en'])).toEqual([]);
  });

  it('sees through zero-width characters and fullwidth digits', () => {
    expect(extractAmounts('$\u200b99', ['en'])).toHaveLength(1);
    expect(extractAmounts('＄９９', ['en'])).toHaveLength(1);
  });
});

describe('8. stripping keeps markdown and points to the cards', () => {
  it('keeps list structure when only a chip failed and when a sentence failed', () => {
    const list = answer('Intro.\n\n- one\n- two', { chips: ['only $1'] });
    const chipOnly = stripViolations(list, checkPrices(list, context()));
    expect(chipOnly.text).toBe('Intro.\n\n- one\n- two');
    const withBad = answer('Intro. It is $1.\n\n- one');
    const stripped = stripViolations(withBad, checkPrices(withBad, context()), 'ru-RU');
    expect(stripped.text).toBe('Intro.\n\n- one Цены указаны в карточках.');
  });
});

describe('10-13. tools', () => {
  it('caps status at 80 chars, ignores presentation status, holds two per turn across loops', () => {
    const statuses: string[] = [];
    const first = newTurnState(new Set(['jacket-wool']), [], statuses);
    executeTool(store, first, toolCall('search_products', { query: 'x', status: 'y'.repeat(200) }));
    executeTool(
      store,
      first,
      toolCall('present_products', { picks: [{ id: 'jacket-wool' }], status: 'no' }),
    );
    const second = newTurnState(new Set(), [], statuses);
    executeTool(store, second, toolCall('search_products', { query: 'x', status: 'two' }));
    executeTool(store, second, toolCall('search_products', { query: 'x', status: 'three' }));
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.length).toBeLessThanOrEqual(80);
    expect(statuses[1]).toBe('two');
  });

  it('sanitizes model-written component strings', () => {
    const state = newTurnState(new Set(['jacket-wool']), []);
    executeTool(
      store,
      state,
      toolCall('present_products', {
        title: 'Top [pick](http://evil)',
        picks: [{ id: 'jacket-wool', reason: 'warm <b>wool</b>\u202e' }],
      }),
    );
    const component = state.components[0];
    const strings =
      component?.type === 'products'
        ? [component.title ?? '', ...component.picks.map((pick) => pick.reason ?? '')]
        : [];
    expect(strings.join(' ')).not.toMatch(/[[\]<>\u202E]/);
  });

  it('accepts numeric price limits, rejects unreadable ones, and dedupes comparisons', () => {
    const state = newTurnState(new Set(['jacket-wool', 'jacket-rain']), []);
    const numeric = JSON.parse(
      executeTool(
        store,
        state,
        toolCall('search_products', { query: '', filters: { max_price: 80 } }),
      ).content,
    );
    expect(numeric.results.map((result: { id: string }) => result.id)).toEqual([
      'jacket-rain',
      'scarf',
    ]);
    const bad = JSON.parse(
      executeTool(
        store,
        state,
        toolCall('search_products', { query: '', filters: { max_price: 'cheap' } }),
      ).content,
    );
    expect(bad.error).toBeDefined();
    const monthly = JSON.parse(
      executeTool(
        store,
        state,
        toolCall('search_products', { query: '', filters: { frequency: 'month' } }),
      ).content,
    );
    expect(monthly.results.map((result: { id: string }) => result.id)).toEqual(['box']);
    const self = executeTool(
      store,
      state,
      toolCall('present_comparison', { ids: ['jacket-wool', 'jacket-wool'], rows: [] }),
    );
    expect(self.isError).toBe(true);
  });

  it('reports the full match count, not the page size', () => {
    const state = newTurnState(new Set(), []);
    const result = JSON.parse(
      executeTool(store, state, toolCall('search_products', { query: '', limit: 1 })).content,
    );
    expect(result.results).toHaveLength(1);
    expect(result.total).toBeGreaterThan(1);
  });
});

describe('15-17. failures, estimates and adapters', () => {
  it('carries spent usage on a provider failure', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      model: 'x',
      async turn() {
        calls += 1;
        if (calls === 2) {
          throw new Error('boom');
        }
        return {
          text: '',
          toolCalls: [toolCall('search_products', { query: 'x' })],
          stopReason: 'tool_use',
          usage: { inputTokens: 7, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        };
      },
    };
    const error = await runTurn(input(provider)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TurnError);
    expect(error instanceof TurnError && error.usage.inputTokens).toBe(7);
    expect(error instanceof TurnError && error.modelCalls).toBe(1);
  });

  it('estimates non-Latin text conservatively', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('ж'.repeat(300))).toBe(200);
  });

  it('reads DeepSeek cache fields, subtracts cache writes and joins text parts', async () => {
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://x.example.com',
      passCacheMarks: true,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: 'text', text: 'a' },
                    { type: 'text', text: 'b' },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 1,
              prompt_cache_hit_tokens: 30,
              prompt_tokens_details: { cache_write_tokens: 20 },
            },
          }),
        );
      },
    });
    const response = await provider.turn({
      system: [{ text: 's', cache: true }],
      messages: [],
      tools: [],
      maxTokens: 1,
    });
    expect(response.text).toBe('ab');
    expect(response.usage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      outputTokens: 1,
    });
  });

  it('errors carry only the status, never the body', async () => {
    for (const provider of [
      createAnthropicProvider({
        apiKey: 'k',
        model: 'm',
        fetch: async () => new Response('secret prompt echo', { status: 500 }),
      }),
      createOpenAiCompatibleProvider({
        apiKey: 'k',
        model: 'm',
        baseUrl: 'https://x.example.com',
        fetch: async () => new Response('secret prompt echo', { status: 429 }),
      }),
    ]) {
      const request: TurnRequest = { system: [], messages: [], tools: [], maxTokens: 1 };
      const error = await provider.turn(request).catch((caught: unknown) => caught);
      expect(String(error)).not.toContain('secret');
      expect(String(error)).toMatch(/status (500|429)/);
    }
  });

  it('marks the last message for caching on Anthropic', async () => {
    let body: Record<string, unknown> = {};
    const provider = createAnthropicProvider({
      apiKey: 'k',
      model: 'm',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ content: [], usage: {} }));
      },
    });
    await provider.turn({
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [],
      maxTokens: 1,
      cacheLastMessage: true,
    });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('untested paths from round 1', () => {
  it('uses the current visitor message for the budget rule (A) and sanitizes the text (C)', async () => {
    const { provider } = scripted([{ text: 'All good under $130. [x](http://evil)' }]);
    const output = await runTurn(input(provider));
    expect(output.stripped).toEqual([]);
    expect(output.answer.text).not.toMatch(/[[\]]/);
  });

  it('uses policy passages returned this turn (G)', async () => {
    const { provider } = scripted([
      { calls: [toolCall('search_policies', { query: 'shipping' })] },
      { text: 'EU shipping is €15.' },
    ]);
    const output = await runTurn(input(provider));
    expect(output.answer.text).toBe('EU shipping is €15.');
  });

  it('applies the visitor rule to component strings only without an id (I)', () => {
    const reasoned = answer('', {
      components: [
        {
          type: 'products',
          picks: [{ address: address('jacket-wool'), reason: 'fits your $130' }],
        },
      ],
    });
    expect(checkPrices(reasoned, context(['under $130']))).toHaveLength(1);
  });

  it('returns the text of the forced round even if the model still calls tools', async () => {
    const provider: LlmProvider = {
      model: 'x',
      async turn(request) {
        return {
          text: request.toolChoice === 'none' ? 'final' : '',
          toolCalls: [toolCall('search_products', { query: 'x' })],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        };
      },
    };
    const output = await runTurn(input(provider));
    expect(output.answer.text).toBe('final');
  });

  it('records shown products in history and continues allowed ids across turns', async () => {
    const first = scripted([
      { calls: [toolCall('search_products', { query: 'jacket' })] },
      {
        calls: [
          toolCall('present_products', { picks: [{ id: 'jacket-wool' }, { id: 'jacket-rain' }] }),
        ],
      },
      { text: 'Two options.' },
    ]);
    const one = await runTurn(input(first.provider));
    const note = one.history.at(-1)?.content[0];
    expect(note?.type === 'text' && note.text).toContain('[shown, in order: 1. jacket-wool');
    const second = scripted([
      { calls: [toolCall('present_products', { picks: [{ id: 'jacket-rain' }] })] },
      { text: 'The second one.' },
    ]);
    const two = await runTurn({
      ...input(second.provider),
      history: one.history,
      earlierAllowedIds: one.allowedIds,
    });
    expect(two.answer.components).toHaveLength(1);
  });
});

describe('currency words with trailing punctuation', () => {
  it('reads a currency word at the end of a sentence', () => {
    for (const text of [
      'It costs 99 dollars.',
      'Only 99 euros!',
      'Всего 99 руб.',
      'Это 99 р.',
      '99 гривен?',
    ]) {
      expect(extractAmounts(text, ['en', 'ru']).length).toBe(1);
    }
    expect(checkPrices(answer('It costs 99 dollars.'), context())).toHaveLength(1);
  });
});

describe('every currency word form the old table read is still read', () => {
  it('covers each stem', () => {
    for (const text of [
      '9 dollar',
      '9 dollars',
      '9 bucks',
      '9 dólares',
      '9 euro',
      '9 euros',
      '9 евро',
      '9 quid',
      '9 yen',
      '9 yuan',
      '9 рмб',
      '9 руб',
      '9 рубль',
      '9 рубля',
      '9 рублей',
      '9 рубли',
      '9 р.',
      '9 гривна',
      '9 гривны',
      '9 грн',
      '9 real',
      '9 reais',
      '9 rupee',
      '9 rupees',
    ]) {
      expect(extractAmounts(text, ['en']).length, text).toBe(1);
    }
  });
});

describe('pound is money only in a GBP store', () => {
  it('reads pounds in GBP and not elsewhere', () => {
    expect(extractAmounts('costs 9 pounds', ['en'], 'GBP')[0]?.currencies).toEqual(['GBP']);
    expect(extractAmounts('holds 50 pounds', ['en'], 'USD')).toEqual([]);
  });
});
