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

function store(currency: string, text: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const gloves = item({ d: 'gloves', title: 'Gloves', price: { amount: '30', currency } });
  const catalog = new StoreCatalog(
    { ...CONFIG, currency, language: 'en' },
    undefined,
    [jacket, gloves],
    [],
  );
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: catalog.items,
    visitorMessages: [],
    policyPassages: [],
    locales: ['en', 'en'],
  }).length;
}

describe('A1. an unrelated word after a symbol price never blanks it', () => {
  it.each([
    'The Gloves are a $30.00 cup holder.',
    'The Gloves come with a $30.00 gel pack.',
    'The Gloves sell at $30.00 pen included.',
    'The Gloves are $30.00 all in.',
    'The Gloves are $30.00 TOP seller.',
    'The Jacket is $1200 AMD edition.',
  ])('"%s" passes', (text) => {
    expect(store('USD', text)).toBe(0);
  });

  it('a lowercase code that the symbol could mean is still no restatement', () => {
    expect(store('USD', 'The Gloves come in a $30.00 cop costume set.')).toBe(0);
  });

  it('a currency word after a symbol price still restates it', () => {
    expect(store('USD', 'The Jacket costs $1200 yen.')).toBe(1);
    expect(store('USD', 'The Jacket costs $1200 dollars.')).toBe(0);
  });

  it('"$1200 CAD" still narrows to CAD in a USD store', () => {
    expect(store('USD', 'The Jacket costs $1200 CAD.')).toBe(1);
  });
});

describe('A2. any hyphenated lowercase-first name after U.S. starts a sentence', () => {
  it.each([
    'The Jacket ships across the U.S. eco-Gloves cost $1200.',
    'The Jacket ships across the U.S. ultra-Gloves cost $1200.',
    'The Jacket ships across the U.S. pro-Gloves cost $1200.',
  ])('"%s" is caught', (text) => {
    expect(store('USD', text)).toBe(1);
  });
});

describe('word-like codes after a noun need a decimal amount to contradict it', () => {
  it.each([
    ['EUR', 'de', 'Die Jacket kostet 1200 € TOP Angebot.'],
    ['EUR', 'de', 'Die Jacket kostet 1200 € GEL inklusive.'],
    ['EUR', 'en', 'The Jacket is 1200 euros ALL IN.'],
    ['EUR', 'en', 'The Jacket is 1200 euros NEW arrivals.'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });
});
