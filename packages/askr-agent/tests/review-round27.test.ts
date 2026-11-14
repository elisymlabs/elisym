import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { cardsPointer, checkPrices, extractAmounts, stripViolations } from '../src/price-check';
import { runTurn } from '../src/turn';
import { CONFIG, NOW, item, scripted } from './fixtures';

const answer = (text: string): Answer => ({
  type: 'answer',
  ask_id: '0'.repeat(32),
  session_end: 1,
  text,
  components: [],
  chips: [],
});

function storeOf(currency: string, language: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  return new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
}

function contextOf(currency: string, language: string) {
  return {
    storeCurrency: currency,
    items: storeOf(currency, language).items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, language],
  };
}

function strip(currency: string, language: string, text: string) {
  const first = answer(text);
  return stripViolations(first, checkPrices(first, contextOf(currency, language)), language).text;
}

describe('A1. a symbol closing the previous amount stays', () => {
  it.each([
    [
      'CHF',
      'de',
      'Die Jacket kostet 1200 Fr. 3 Farben sind verfügbar.',
      'Die Jacket kostet 1200 Fr.',
    ],
    [
      'INR',
      'en',
      'The Jacket costs 1200 Rs. 3 colours are available.',
      'The Jacket costs 1200 Rs.',
    ],
  ])('%s %s: "%s" keeps "%s"', (currency, language, text, kept) => {
    const result = strip(currency, language, text);
    expect(result.startsWith(kept)).toBe(true);
  });
});

describe('A3. a removed borrower takes its lender sentence', () => {
  it.each([
    ['INR', 'en', 'Delivery costs Rs. 50 extra. 3 colours.', 'costs'],
    ['INR', 'en', 'The Jacket costs Rs. 1500 today. 999 people bought it.', 'costs'],
  ])('%s %s: "%s" no longer reads "%s" before a number', (currency, language, text, word) => {
    const result = strip(currency, language, text);
    expect(result).not.toContain(word);
    expect(checkPrices(answer(result), contextOf(currency, language))).toHaveLength(0);
  });
});

describe('A2/A4. the strip loop ends clean, with one pointer', () => {
  it('a kr. list in a DKK store', async () => {
    const { provider } = scripted([
      { text: 'Jacket koster kr. 1500.\n2 farver\n3 størrelser\n5 års garanti\n10 dages retur' },
    ]);
    const output = await runTurn({
      catalog: storeOf('DKK', 'da'),
      provider,
      history: [],
      askId: 'a'.repeat(32),
      text: 'pris?',
      locale: 'en',
      sessionEnd: NOW + 3_600,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    });
    expect(checkPrices(output.answer, contextOf('DKK', 'da'))).toHaveLength(0);
    expect(output.answer.text.split(cardsPointer('en')).length - 1).toBe(1);
    expect(output.stripped.length).toBeGreaterThan(0);
  });
});

describe('the pointer is appended once', () => {
  it('a text that already ends with the pointer does not get a second one', () => {
    const pointer = cardsPointer('en');
    const first = answer(`The Jacket is Rs. 999 now. ${pointer}`);
    const cleaned = stripViolations(first, checkPrices(first, contextOf('INR', 'en')), 'en');
    expect(cleaned.text.split(pointer).length - 1).toBe(1);
  });
});

describe('B. coverage', () => {
  it.each([
    ['NOK', 'nb', 'Jakken koster kr. 1500 nå.'],
    ['SEK', 'sv', 'Jackan kostar kr. 1500 nu.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(checkPrices(answer(text), contextOf(currency, language))).toHaveLength(1);
  });

  it('"Mo. bis Fr. 2 Tage" is no franc price', () => {
    expect(extractAmounts('Der Versand dauert Mo. bis Fr. 2 Tage.', ['de'], 'CHF')).toHaveLength(0);
  });
});
