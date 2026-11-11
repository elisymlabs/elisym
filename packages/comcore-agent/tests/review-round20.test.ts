import type { Answer } from '@elisym/comcore';
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

describe("A1. a store's own multi-word name is read before any qualifier token", () => {
  it.each([
    ['ZAR', 'en', 'The Jacket costs 999 South African rand.'],
    ['TWD', 'en', 'The Jacket costs 999 New Taiwan dollars.'],
    ['ILS', 'de', 'Die Jacket kostet 999 Israelische Neue Schekel.'],
    ['ILS', 'uk', 'Jacket коштує 999 ізраїльських нових шекелів.'],
    ['SSP', 'en', 'The Jacket costs 999 South Sudanese pounds.'],
    ['AED', 'en', 'The Jacket costs 999 UAE dirhams.'],
    ['EGP', 'en', 'The Jacket costs 999 Egyptian pounds.'],
    ['USD', 'en', 'The Jacket costs 999 United States dollars.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('A2. "U.S." does not end the sentence', () => {
  it.each([
    ['USD', 'The Jacket is 999 U.S. dollars.'],
    ['EUR', 'The Jacket is 999 U.S. dollars.'],
    ['USD', 'Price: 999 U.S. dollars today.'],
  ])('%s: "%s" is caught', (currency, text) => {
    expect(violationsIn(currency, 'en', text)).toBe(1);
  });
});

describe('A3. a qualifier-like word exposes no other currency', () => {
  it.each([
    'It comes with 2 new real leather straps.',
    'Set of 2 polished real brass handles.',
    'Add 2 individual real wood trays.',
    'Includes 2 Chinese real silk scarves.',
    'Includes 2 new rub pads.',
    'Includes 2 new cop figures.',
    'With 2 new pesos coins.',
  ])('"%s" has no money', (text) => {
    expect(extractAmounts(text, ['en'], 'EUR')).toHaveLength(0);
  });
});

describe('B1-B3. a qualifier pins its currency', () => {
  it.each([
    ['USD', 'en', 'The Jacket is 1200 Canadian dollars.'],
    ['USD', 'en', 'The Jacket is 1200 Hong Kong dollars.'],
    ['USD', 'en', 'The Jacket is 1200 Australian dollars.'],
    ['USD', 'de', 'Die Jacket kostet 1200 kanadische Dollar.'],
    ['USD', 'en', 'The Jacket is 1200 NZ dollars.'],
    ['USD', 'en', 'The Jacket is 1200 HK dollars.'],
    ['EUR', 'en', 'The Jacket is 1200 hryvnias.'],
  ])('%s %s: "%s" is not the store price', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('a qualifier naming the store currency passes the real price', () => {
    expect(violationsIn('CAD', 'en', 'The Jacket is 1200 Canadian dollars.')).toBe(0);
    expect(violationsIn('USD', 'en', 'The Jacket is 1200 US dollars.')).toBe(0);
  });
});
