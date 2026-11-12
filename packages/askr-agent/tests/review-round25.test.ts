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

function store(currency: string, language: string, text: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const gloves = item({ d: 'gloves', title: 'Gloves', price: { amount: '30', currency } });
  const catalog = new StoreCatalog(
    { ...CONFIG, currency, language },
    undefined,
    [jacket, gloves],
    [],
  );
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: catalog.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, language],
  }).length;
}

describe('A1. a kr symbol price followed by another kr currency is caught', () => {
  it.each([
    ['SEK', 'en', 'The Jacket costs kr 1200 NOK.'],
    ['NOK', 'en', 'The Jacket costs kr 1200 SEK.'],
    ['DKK', 'da', 'Jacket koster kr. 1200 SEK.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(store(currency, language, text)).toBe(1);
  });

  it.each([
    ['SEK', 'en', 'The Jacket costs kr 1200 SEK.'],
    ['DKK', 'da', 'Jacket koster kr. 1200 DKK.'],
  ])('%s %s: the real price in "%s" passes', (currency, language, text) => {
    expect(store(currency, language, text)).toBe(0);
  });
});

describe('A2. a word-like code never contradicts a noun', () => {
  it.each([
    ['EUR', 'de', 'Die Gloves: nur 30,00 € TOP Preis!'],
    ['EUR', 'de', 'Die Jacket gibt es für 1200,00 € TOP Angebot.'],
    ['USD', 'en', 'The Gloves are 30.00 USD TOP seller.'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(store(currency, language, text)).toBe(0);
  });

  it('a real contradicting code still fails closed', () => {
    expect(store('USD', 'en', 'The Jacket is 1200.00 dollars EUR.')).toBe(1);
  });
});

describe('B. restatement edge cases', () => {
  it('a space after the symbol still restates: "$ 1200 CAD"', () => {
    expect(store('USD', 'en', 'The Jacket costs $ 1200 CAD.')).toBe(1);
  });

  it('a currency word ending in a code ("pesos") still restates', () => {
    expect(store('USD', 'en', 'The Jacket costs $1200 pesos.')).toBe(1);
  });
});
