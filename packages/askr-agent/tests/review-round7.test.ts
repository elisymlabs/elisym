import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { CONFIG, item } from './fixtures';

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
  extractAmounts(text, locales, currency).map((amount) => amount.values.map(String));

describe('1. a tilde between two numbers is a range, not markdown', () => {
  it.each([
    ['JPY', 'ja', 'Socks: 1,500～2,000円'],
    ['JPY', 'ja', 'Jacket: 1,500～2,000円'],
    ['USD', 'en', 'Jacket: $1200~1500'],
  ])('%s %s: an invented bound is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['JPY', 'ja', 'Jacket: ¥1200～1200'],
    ['JPY', 'ja', 'Jacket: 1200～1200円'],
    ['USD', 'en', 'Jacket: $1200~1200'],
    ['USD', 'en', 'Jacket: $**1200**'],
  ])('%s %s: real prices pass', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });
});

describe('2. only a real range shape carries the currency', () => {
  it.each([
    ['USD', 'en', 'Jacket: $1200 to 2 people'],
    ['USD', 'en', 'Jacket costs $1200 - 2026 edition'],
    ['USD', 'en', 'Jacket $1200 – 2 left in stock'],
    ['USD', 'en', 'Jacket is $1200 a 2nd one free'],
    ['USD', 'en', 'Jacket is $1200 a 2000 thread count'],
    ['EUR', 'es', 'Jacket 1200 € a 3 días'],
    ['EUR', 'pt', 'Jacket 1200 € a 2 pessoas'],
    ['RUB', 'ru', 'Jacket \u2014 1200 ₽ до 30 ноября'],
    ['EUR', 'de', 'Jacket 1200 € bis 24 Uhr'],
    ['EUR', 'de', 'Jacket 1200 € bis 31.12.'],
    ['USD', 'en', 'Jacket: $1200-1500%'],
    ['USD', 'en', 'Jacket: $1200-1300h'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it.each([
    ['EUR', 'es', 'Jacket de 1200 € a 1500'],
    ['EUR', 'de', 'Jacket von 1200 € bis 1500'],
    ['RUB', 'ru', 'Jacket от 1200 ₽ до 1500'],
  ])('%s %s: the upper bound of "%s" is checked', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('the upper bound keeps the lower bound currency, not the store one', () => {
    // 1200 is the jacket's EUR price; as dollars it is invented.
    expect(
      violationsIn('EUR', 'en', 'Jacket shipping $15-1200', { policies: ['Express shipping $15'] }),
    ).toBe(1);
  });
});

describe('3. opening hours in a CHF store', () => {
  it.each([
    'Wir haben Mo.-Fr. 9-18 Uhr offen.',
    'Abholung Di.-Fr. 10 Uhr',
    'Jacket CHF 1200. Öffnungszeiten Mo.-Fr. 9-18 Uhr',
    'Jacket CHF 1200, Mo.–Fr. 9.00–18.30',
    'Abholung Fr. 9:30',
  ])('"%s" passes', (text) => {
    expect(violationsIn('CHF', 'de-CH', text)).toBe(0);
  });

  it('a franc price after the hours is still read', () => {
    expect(violationsIn('CHF', 'de-CH', 'Mo.-Fr. offen. Nur Fr. 99 heute.')).toBe(1);
  });
});

describe("4. the visitor's own range repeated", () => {
  it.each([
    ['My budget is $90-150', 'I can look for something in your $90-150 budget.'],
    ['anything from $90 to 150?', 'I will look from $90 to 150.'],
  ])('"%s" then "%s" passes', (visitor, text) => {
    expect(violationsIn('USD', 'en', text, { visitor: [visitor] })).toBe(0);
  });

  it('two separate figures are not a repeated range', () => {
    expect(
      violationsIn('USD', 'en', 'Pick $90 or $150.', { visitor: ['between $90 and $150'] }),
    ).toBe(1);
  });
});

describe('5. the lower bound of a range with the currency after it', () => {
  it.each([
    ['USD', 'en', 'Jacket: 999-1200 USD'],
    ['USD', 'en', 'Jacket: from 999 to 1200 USD'],
    ['USD', 'en', 'Jacket: 999 - 1200 dollars'],
    ['EUR', 'de', 'Jacket: 999–1200 €'],
    ['EUR', 'de', 'Jacket: 999 bis 1200 €'],
    ['RUB', 'ru', 'Jacket: от 999 до 1200 ₽'],
    ['RUB', 'ru', 'Jacket: 999-1200 руб.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('a real range passes', () => {
    expect(violationsIn('USD', 'en', 'Jacket: 1200-1200 USD')).toBe(0);
  });

  // Fail closed (round 9): a bare number before a dash and an amount is a lower
  // bound unless exact evidence says otherwise; a model name costs a re-run.
  it.each([
    ['EUR', 'de', 'Jacket: das iPhone 15 - 1200 €'],
    ['USD', 'en', 'Jacket for 2 - 1200 USD'],
  ])('%s %s: "%s" is read as a range', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('6. a symbol closing one number does not open the next', () => {
  it('"1200 € - 2 Farben" is one amount', () => {
    expect(violationsIn('EUR', 'de', 'Jacket 1200 € - 2 Farben')).toBe(0);
    expect(valuesOf('USD - 99', ['en'])).toEqual([['99']]);
  });
});

describe('test gaps', () => {
  it('Arabic thousands sign', () => {
    expect(valuesOf('١٬٥٠٠ ر.س', ['ar-SA'], 'SAR')).toEqual([['1500']]);
    expect(violationsIn('SAR', 'ar-SA', 'السعر ١٬٥٠٠ ر.س')).toBe(1);
  });

  it('Indian grouping is read only where the decimal sign is a point', () => {
    expect(valuesOf('₹1,23,456', ['de'])).not.toContainEqual(['123456']);
  });

  it('a number does not start right after a digit and a separator', () => {
    expect(valuesOf('1,234,567,890,123,456 USD', ['en'])).not.toContainEqual(['456']);
    expect(valuesOf('firmware v1.5.99 USD', ['en'])).not.toContainEqual(['5.99']);
  });

  it('a sentence that starts with a number is its own sentence (no borrowed product name)', () => {
    expect(violationsIn('USD', 'en', 'The Jacket fits well. 1200 USD buys the scarf.')).toBe(1);
  });

  it('a range opener before a spaced dash keeps the range', () => {
    expect(violationsIn('USD', 'en', 'Jacket: from 999 - 1200 USD')).toBe(1);
  });

  it('a number above the amount after it is not its lower bound', () => {
    expect(violationsIn('USD', 'en', 'Jacket, 2026 – 1200 USD')).toBe(0);
  });
});
