import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { createOpenAiCompatibleProvider } from '../src/llm/openai-compatible';
import { checkPrices, extractAmounts } from '../src/price-check';
import { runTurn } from '../src/turn';
import { CATALOG_KEY, CONFIG, NOW, catalog, item, scripted, toolCall } from './fixtures';

const address = (d: string) => `30402:${CATALOG_KEY}:${d}`;
const answer = (text: string, overrides: Partial<Answer> = {}): Answer => ({
  type: 'answer',
  ask_id: '0'.repeat(32),
  session_end: 1,
  text,
  components: [],
  chips: [],
  ...overrides,
});

function storeIn(currency: string, language: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  return new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
}

describe('1. every store currency form is read', () => {
  const cases: Array<[string, string, string]> = [
    ['JPY', 'ja', 'このジャケットは1500円です。'],
    ['CNY', 'zh', '这件夹克1500元。'],
    ['SEK', 'sv', 'Jakken koster 1500 kr.'],
    ['CZK', 'cs', 'Bunda stojí 1500 Kč.'],
    ['THB', 'th', 'ราคา ฿1500'],
    ['IDR', 'id', 'Harganya Rp 1500'],
    ['ZAR', 'en', 'It costs R 1500.'],
  ];
  for (const [currency, language, text] of cases) {
    it(`${currency}: an invented price is caught`, () => {
      const store = storeIn(currency, language);
      const violations = checkPrices(answer(text), {
        storeCurrency: currency,
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: [language, language],
      });
      expect(violations).toHaveLength(1);
    });
  }
});

describe('2-4. grammar edge cases', () => {
  it('stays fast on a long grouped run', () => {
    const started = performance.now();
    extractAmounts('111 '.repeat(4_000), ['en']);
    extractAmounts('$ 111 '.repeat(2_000), ['en']);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('keeps two different numbers apart and one number read twice as one', () => {
    expect(extractAmounts('$99 USD', ['en'])).toHaveLength(1);
    expect(extractAmounts('It is 120 USD 30 cheaper', ['en'])).toHaveLength(2);
    const store = catalog();
    const bad = answer('The Wool jacket is 120 USD 30 cheaper than before.');
    expect(
      checkPrices(bad, {
        storeCurrency: 'USD',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['en'],
      }),
    ).toHaveLength(1);
  });

  it('reads wider separators between token and number', () => {
    for (const text of ['99  USD', 'USD:99', 'USD-99', 'USD - 99']) {
      expect(extractAmounts(text, ['en']).length, text).toBe(1);
    }
  });
});

describe('5. untested round-2 fixes', () => {
  const store = catalog();
  const context = {
    storeCurrency: 'USD',
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: ['en'],
  };

  it('does not sum a one-off and a monthly price in one component', () => {
    const both = answer('Both come to $135.', {
      components: [
        {
          type: 'products',
          picks: [{ address: address('jacket-wool') }, { address: address('box') }],
        },
      ],
    });
    expect(checkPrices(both, context)).toHaveLength(1);
  });

  it('keeps a stripped near-limit answer within the text limit', async () => {
    const long = `${'Good choice for winter. '.repeat(160)}It is $5.`;
    const { provider } = scripted([{ text: long }]);
    const output = await runTurn({
      catalog: store,
      provider,
      history: [],
      askId: 'a'.repeat(32),
      text: 'x',
      sessionEnd: NOW + 60,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    });
    expect(output.stripped.length).toBeGreaterThan(0);
    expect(output.answer.text.length).toBeLessThanOrEqual(4_000);
  });
});

describe('cache marks on tool rounds', () => {
  const run = async (cacheLastMessage: boolean) => {
    let body: Record<string, unknown> = {};
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'k',
      model: 'anthropic/x',
      baseUrl: 'https://x.example.com',
      passCacheMarks: true,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
        );
      },
    });
    await provider.turn({
      system: [],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [toolCall('search_products', { query: 'x' })] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call', content: 'r' }] },
      ],
      tools: [],
      maxTokens: 1,
      cacheLastMessage,
    });
    return body.messages as Array<{ role: string; content: unknown }>;
  };

  it('marks the last tool message', async () => {
    const messages = await run(true);
    expect(messages.at(-1)?.role).toBe('tool');
    expect(messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'r', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks nothing without cacheLastMessage', async () => {
    const messages = await run(false);
    expect(messages.at(-1)?.content).toBe('r');
  });
});

describe('caches stay bounded under visitor-chosen locales', () => {
  it('handles many distinct locales without growing past the cap', () => {
    for (let index = 0; index < 2_000; index++) {
      extractAmounts('99 USD', [`en-x-${index.toString(36).padStart(4, 'a')}`], 'USD');
    }
    expect(extractAmounts('99 USD', ['en-x-zzzz'], 'USD')).toHaveLength(1);
  });
});

describe('regional currency forms', () => {
  it('reads the region-specific form of the store currency', () => {
    // es-MX writes MXN as "$", es-ES as "MXN": a MXN store answering es-MX is read.
    expect(extractAmounts('cuesta $1500', ['es-MX'], 'MXN')[0]?.currencies).toContain('MXN');
    // en-CA writes CAD as "$".
    expect(extractAmounts('it is $99', ['en-CA'], 'CAD')[0]?.currencies).toContain('CAD');
  });
});
