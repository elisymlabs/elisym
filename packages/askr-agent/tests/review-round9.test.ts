import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { executeTool, newTurnState } from '../src/tools';
import { CONFIG, catalog, item, toolCall } from './fixtures';

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

const ranged = (text: string, language: string, currency: string) =>
  extractAmounts(text, [language], currency).length;

describe('1. units and months are exact words, not stems', () => {
  it.each([
    ['USD', 'en', 'Jacket: $1200 to 1500 separately'],
    ['USD', 'en', 'Jacket: $1200-1500 junior sizes'],
    ['USD', 'en', 'Jacket: $1200 to 1500 mainly'],
    ['USD', 'en', 'Jacket: $1200 to 1500 market price'],
    ['USD', 'en', 'Jacket: $1200 to 1500 margin'],
    ['USD', 'en', 'Jacket: $1200 to 1500 approx'],
    ['USD', 'en', 'Jacket: $1200 to 1500 decent'],
    ['USD', 'en', 'Jacket: $1200-1500 an hour'],
    ['USD', 'en', 'Jacket: $1200-1500 m'],
    ['EUR', 'fr', 'Jacket : 1200 € à 1500 marque comprise'],
    ['EUR', 'es', 'Jacket: 1200 € a 1500 agotado pronto'],
    ['RUB', 'ru', 'Jacket: 1200 ₽ до 1500 часто'],
    ['RUB', 'ru', 'Jacket: 1200 ₽ до 1500 годных'],
    ['RUB', 'ru', 'Jacket: 1200 ₽ до 1500 марок'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['USD', 'en', 'Jacket: $5 to 31 December'],
    ['USD', 'en', 'Jacket: $5 to 31 Dec.'],
    ['EUR', 'de', 'Jacket: 5 € bis 31. März'],
    ['EUR', 'fr', 'Jacket: 5 € à 31 janvier'],
    ['RUB', 'ru', 'Jacket: 5 ₽ до 31 декабря'],
    ['USD', 'en', 'Jacket: $5 to 10 days'],
    ['EUR', 'de', 'Jacket: 5 € bis 10 Stück'],
  ])('%s %s: "%s" reads no upper bound', (currency, language, text) => {
    expect(ranged(text, language, currency)).toBe(1);
  });
});

describe('2. a sentence end is not a date', () => {
  it('an upper bound before ". Word" is still read', () => {
    expect(ranged('Costs $1200 to 1500. Warm and light.', 'en', 'USD')).toBe(2);
  });
});

describe('3. a year upper bound is a price unless an edition word follows', () => {
  it.each([
    ['USD', 'en', 'Jacket ranges $1200 to 1999 depending on size'],
    ['EUR', 'de', 'Jacket kostet 1200 € bis 2000 je nach Größe'],
    ['RUB', 'ru', 'Jacket стоит от 1200 ₽ до 2000 в зависимости от размера'],
    ['USD', 'en', 'Jacket runs $1200 - 2000 with the hood'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('"$1200 - 2026 edition" passes', () => {
    expect(violationsIn('USD', 'en', 'Jacket costs $1200 - 2026 edition')).toBe(0);
  });
});

describe('4. no ratio rule: a low bound far below the upper is still read', () => {
  it.each([
    ['USD', 'en', 'Our Jacket costs 49 to 1200 USD.'],
    ['USD', 'en', 'Jacket: 49-1200 USD'],
    ['EUR', 'de', 'Jacket kostet 49 bis 1200 €.'],
    ['RUB', 'ru', 'Jacket стоит 49 до 1200 ₽'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('5. compound price words are the price row', () => {
  it('Endpreis, Gesamtpreis, Stückpreis, Totaalprijs and Unitprice rows are dropped', () => {
    const state = newTurnState(new Set(['jacket-wool', 'jacket-rain']), []);
    executeTool(
      catalog(),
      state,
      toolCall('present_comparison', {
        ids: ['jacket-wool', 'jacket-rain'],
        rows: [
          { dimension: 'Endpreis', cells: ['ca. 140 inkl. MwSt.', 'ca. 95 inkl. MwSt.'] },
          { dimension: 'Totaalprijs', cells: ['ongeveer 140', 'ongeveer 95'] },
          { dimension: 'Warmth', cells: ['high', 'low'] },
        ],
      }),
    );
    executeTool(
      catalog(),
      state,
      toolCall('present_comparison', {
        ids: ['jacket-wool', 'jacket-rain'],
        rows: [
          { dimension: 'Gesamtpreis', cells: ['about 140', 'about 95'] },
          { dimension: 'Stückpreis', cells: ['a', 'b'] },
          { dimension: 'Unitprice', cells: ['a', 'b'] },
          { dimension: 'Warmth', cells: ['high', 'low'] },
        ],
      }),
    );
    const dimensions = state.components.map((component) =>
      component.type === 'comparison' ? component.rows.map((row) => row.dimension) : [],
    );
    expect(dimensions).toEqual([
      ['Price', 'Warmth'],
      ['Price', 'Warmth'],
    ]);
  });
});

describe('6. article, item and year numbers before a dash', () => {
  it.each([
    ['EUR', 'de', 'Jacket Art. 900 - 1200 €'],
    ['EUR', 'de', 'Jacket Nr. 950 – 1200 €'],
    ['USD', 'en', 'Jacket SKU 500 - $1200'],
    ['USD', 'en', 'Jacket, item 300 - $1200'],
    ['USD', 'en', 'Jacket #300 - $1200'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it('an abbreviation dot does not end the sentence that names the product', () => {
    expect(violationsIn('EUR', 'de', 'Die Jacket kostet ca. 1200 €.')).toBe(0);
    expect(violationsIn('EUR', 'de', 'Die Jacket kostet ca. 999 €.')).toBe(1);
  });

  it('a year before a spaced dash is not a lower bound', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Ski Jacket',
      price: { amount: '2400', currency: 'USD' },
    });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'USD', language: 'en' },
      undefined,
      [jacket],
      [],
    );
    expect(
      checkPrices(answer('Ski Jacket 2025 - $2400'), {
        storeCurrency: 'USD',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['en', 'en'],
      }),
    ).toHaveLength(0);
  });
});

describe('test gaps', () => {
  it('markdown inside a number in every form', () => {
    expect(extractAmounts('$1*200', ['en']).map((amount) => String(amount.values[0]))).toEqual([
      '1200',
    ]);
    expect(extractAmounts('$1`2`00', ['en']).map((amount) => String(amount.values[0]))).toEqual([
      '1200',
    ]);
    expect(extractAmounts('1_200 USD', ['en']).map((amount) => String(amount.values[0]))).toEqual([
      '1200',
    ]);
  });

  it.each([
    ['USD', 'en', 'Jacket: between $1200 and 1500'],
    ['EUR', 'es', 'Jacket: entre 1200 € y 1500'],
    ['EUR', 'de', 'Jacket: zwischen 999 und 1200 €'],
    ['RUB', 'ru', 'Jacket: между 999 и 1200 ₽'],
  ])('%s %s: a paired range "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('"and" without its opener is not a range', () => {
    expect(ranged('$1200 and 2 scarves', 'en', 'USD')).toBe(1);
    expect(violationsIn('USD', 'en', 'Jacket is $1200 and 1500 people love it')).toBe(0);
  });

  it('English "a" is not a range word', () => {
    expect(violationsIn('USD', 'en', 'Jacket is $1200 a 1500 thread count')).toBe(0);
    expect(violationsIn('USD', 'en', 'Jacket: get 2 a 1200 USD')).toBe(0);
  });

  it('a range opener keeps a year-like lower bound', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Ski Jacket',
      price: { amount: '2400', currency: 'USD' },
    });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'USD', language: 'en' },
      undefined,
      [jacket],
      [],
    );
    const check = (text: string) =>
      checkPrices(answer(text), {
        storeCurrency: 'USD',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['en', 'en'],
      }).length;
    expect(check('Ski Jacket 2000 - $2400')).toBe(0);
    expect(check('Ski Jacket from 2000 - $2400')).toBe(1);
  });

  it('naming products stays fast on a large catalog', () => {
    const items = Array.from({ length: 1_500 }, (_unused, index) =>
      item({
        d: `item-${index}`,
        title: `Product number ${index}`,
        price: { amount: '10', currency: 'USD' },
      }),
    );
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'USD', language: 'en' },
      undefined,
      items,
      [],
    );
    const text = Array.from({ length: 30 }, (_unused, index) => `Option ${index} is $10.`).join(
      ' ',
    );
    const started = performance.now();
    checkPrices(answer(text), {
      storeCurrency: 'USD',
      items: store.items,
      visitorMessages: [],
      policyPassages: [],
      locales: ['en', 'en'],
    });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('a postfix symbol before a dash and no number reads backwards', () => {
    expect(violationsIn('USD', 'en', 'Socks 999 - USD')).toBe(1);
  });
});
