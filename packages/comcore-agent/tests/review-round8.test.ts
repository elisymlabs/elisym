import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { executeTool, newTurnState } from '../src/tools';
import { runTurn } from '../src/turn';
import { CONFIG, NOW, catalog, item, scripted, toolCall } from './fixtures';

const answer = (text: string): Answer => ({
  type: 'answer',
  ask_id: '0'.repeat(32),
  session_end: 1,
  text,
  components: [],
  chips: [],
});

interface Options {
  visitor?: string[];
  policies?: string[];
}

function violationsIn(currency: string, language: string, text: string, options: Options = {}) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: options.visitor ?? [],
    policyPassages: options.policies ?? [],
    locales: [language, language],
  }).length;
}

const valuesOf = (text: string, locales: string[], currency?: string) =>
  describe('1. a spaced dash with a word next to it is still a range', () => {
    it.each([
      ['USD', 'en', 'Jacket ranges $1200 - 1500 depending on size'],
      ['USD', 'en', 'Jacket: $1200 – 1600 with the hood'],
      ['EUR', 'de', 'Jacket kostet 900 – 1200 €'],
      ['RUB', 'ru', 'Jacket стоит 900 - 1200 ₽'],
      ['EUR', 'fr', 'Jacket coûte 900 - 1200 €'],
      ['USD', 'en', 'Jacket is 900 - 1200 USD'],
      ['USD', 'en', 'Jacket goes for 900 - 1200 dollars'],
    ])('%s %s: "%s" is caught', (currency, language, text) => {
      expect(violationsIn(currency, language, text)).toBe(1);
    });

    it.each([
      ['USD', 'en', 'Jacket costs $1200 - 2026 edition'],
      ['EUR', 'de', 'Jacket: das iPhone 15 - 1200 €'],
    ])('%s %s: "%s" passes', (currency, language, text) => {
      expect(violationsIn(currency, language, text)).toBe(0);
    });
  });

describe('2. a symbol that opens the next number does not close the one before', () => {
  it.each([
    'Jacket model 2024 - $1200',
    'Jacket in size 10 - $1200',
    'Jacket option 2 - $1200',
    'Jacket, pack of 3 - $1200',
    'Jacket day 1 - $1200',
  ])('"%s" passes', (text) => {
    expect(violationsIn('USD', 'en', text)).toBe(0);
  });

  it("a size before a budget is not the visitor's figure", () => {
    expect(
      violationsIn('USD', 'en', 'That one is $42.', { visitor: ['I wear size 42 - $100 max'] }),
    ).toBe(1);
  });
});

describe('3. a unit, count or date after a range word', () => {
  it.each([
    ['EUR', 'de', 'Jacket: Versand 1200 € bis 31,5 kg'],
    ['EUR', 'de', 'Jacket: Gutschein 1200 € bis 3100. Dezember'],
    ['EUR', 'de', 'Jacket: Gutschein 12 € bis 31. Dezember'],
    ['RUB', 'ru', 'Jacket: скидка 5 ₽ до 31 декабря'],
    ['EUR', 'de', 'Jacket: Lieferung 5 € bis 50 km'],
    ['EUR', 'de', 'Jacket 45 € bis 50 Stück'],
    ['BRL', 'pt', 'Jacket R$ 45 a 50 unidades'],
    ['USD', 'en', 'Jacket: $45 to 100 people'],
    ['USD', 'en', 'Jacket $1200-1500mAh'],
  ])('%s %s: "%s" reads no upper bound', (currency, language, text) => {
    const amounts = extractAmounts(text, [language], currency);
    expect(amounts).toHaveLength(1);
  });
});

describe('4. "de", "da" and "von" open a range only before their closing word', () => {
  it.each([
    ['EUR', 'fr', 'Jacket, lot de 3 - 1200 €'],
    ['EUR', 'es', 'Jacket, paquete de 3 - 1200 €'],
    ['EUR', 'it', 'Jacket, confezione da 3 - 1200 €'],
    ['EUR', 'pt', 'Jacket, kit de 2 - 1200 €'],
    ['EUR', 'de', 'Jacket, Set von 2 - 1200 €'],
    ['EUR', 'de', 'Jacket, Modell X15-1200 €'],
    ['EUR', 'de', 'Jacket, Modell X900-1200 €'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it.each([
    ['EUR', 'es', 'Jacket de 999 a 1200 €'],
    ['EUR', 'de', 'Jacket von 999 bis 1200 €'],
    ['EUR', 'fr', 'Jacket du 9 à 1200 €'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('5. the range pass is linear', () => {
  it('a long run of amounts takes milliseconds', () => {
    const started = performance.now();
    extractAmounts('$1 '.repeat(8_000), ['en', 'de'], 'USD');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('a policy returned twice is kept once', () => {
    const state = newTurnState(new Set(), []);
    executeTool(catalog(), state, toolCall('search_policies', { query: '' }));
    executeTool(catalog(), state, toolCall('search_policies', { query: '' }));
    expect(state.policyPassages.length).toBe(new Set(state.policyPassages).size);
    expect(state.policyPassages.length).toBeGreaterThan(0);
  });
});

describe('6. tool inputs', () => {
  it('a dimension that only contains a price word is kept', () => {
    const state = newTurnState(new Set(['jacket-wool', 'jacket-rain']), []);
    executeTool(
      catalog(),
      state,
      toolCall('present_comparison', {
        ids: ['jacket-wool', 'jacket-rain'],
        rows: [
          { dimension: 'Оценка', cells: ['отлично', 'хорошо'] },
          { dimension: 'Scenario', cells: ['city', 'hike'] },
          { dimension: 'Costume type', cells: ['a', 'b'] },
          { dimension: 'Total cost', cells: ['x', 'y'] },
          { dimension: 'Цена', cells: ['x', 'y'] },
        ],
      }),
    );
    const component = state.components[0];
    const dimensions =
      component?.type === 'comparison' ? component.rows.map((row) => row.dimension) : [];
    expect(dimensions).toContain('Оценка');
    expect(dimensions).toContain('Scenario');
    expect(dimensions).toContain('Costume type');
    expect(dimensions).not.toContain('Total cost');
    expect(dimensions).not.toContain('Цена');
  });

  it('a grouped price filter is refused, not read as a decimal', () => {
    const state = newTurnState(new Set(), []);
    const outcome = executeTool(
      catalog(),
      state,
      toolCall('search_products', { query: '', filters: { max_price: '1,000' } }),
    );
    expect(outcome.content).toContain('without thousands separators');
  });
});

describe('test gaps', () => {
  it('a lower bound found before the amount shares its group (visitor range repeated)', () => {
    expect(
      violationsIn('USD', 'en', 'That fits 900 to $1500.', {
        visitor: ['my budget is 900 to $1500'],
      }),
    ).toBe(0);
  });

  it('the lower bound is looked for far enough back', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Jacket',
      price: { amount: '12000000', currency: 'RUB' },
    });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'RUB', language: 'ru' },
      undefined,
      [jacket],
      [],
    );
    expect(
      checkPrices(answer('Jacket от 11 100 000,50 до 12 000 000 ₽'), {
        storeCurrency: 'RUB',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['ru', 'ru'],
      }),
    ).toHaveLength(1);
  });

  it('the lower bound is looked for across a long grouped number', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Jacket',
      price: { amount: '1200000', currency: 'RUB' },
    });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'RUB', language: 'ru' },
      undefined,
      [jacket],
      [],
    );
    expect(
      checkPrices(answer('Jacket 1 100 000 – 1 200 000 ₽'), {
        storeCurrency: 'RUB',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['ru', 'ru'],
      }),
    ).toHaveLength(1);
  });

  it('markdown inside a number is dropped, not split', () => {
    expect(extractAmounts('$1**2**00', ['en']).map((amount) => String(amount.values[0]))).toEqual([
      '1200',
    ]);
    expect(violationsIn('USD', 'en', 'Now $9**9**!')).toBe(1);
  });

  it('a dotted symbol at the end of one sentence reads with the number of the next', () => {
    expect(violationsIn('INR', 'en-IN', 'Only Rs. 999 today')).toBe(1);
    // The next sentence does not borrow the previous one's product name.
    expect(violationsIn('USD', 'en', 'The Jacket fits well. 1200 USD buys the scarf.')).toBe(1);
    // A number in the lead is not re-checked against the next sentence.
    expect(violationsIn('USD', 'en', 'The Jacket is $1200. 3 colors.')).toBe(0);
  });

  it('a re-run without suggestions keeps the first loop chips', async () => {
    const { provider } = scripted([
      { calls: [toolCall('present_suggestions', { chips: ['Show rain jackets'] })] },
      { text: 'It is on sale for $99.' },
      { text: 'Here are some ideas.' },
    ]);
    const output = await runTurn({
      catalog: catalog(),
      provider,
      history: [],
      askId: 'a'.repeat(32),
      text: 'ideas?',
      locale: 'en-US',
      sessionEnd: NOW + 3_600,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    });
    expect(output.answer.chips).toEqual(['Show rain jackets']);
  });
});
