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

describe('A1. a range word never joins the currency token', () => {
  it.each([
    ['EUR', 'en', 'The Jacket costs from 1200 euros to 5000.'],
    ['EUR', 'en', 'The Jacket costs between 1200 EUR and 5000.'],
    ['USD', 'en', 'The Jacket costs 1200 dollars to 5000.'],
    ['USD', 'en', 'The Jacket costs 1200 USD to 5000.'],
    ['EUR', 'en', 'The Jacket costs from 1200 euros up to 5000.'],
    ['EUR', 'de', 'Die Jacket kostet zwischen 1200 Euro und 5000.'],
    ['EUR', 'de', 'Die Jacket kostet von 1200 Euro bis 5000.'],
    ['RUB', 'ru', 'Jacket стоит от 1200 рублей до 5000.'],
    ['PLN', 'pl', 'Jacket kosztuje od 1200 zł do 5000.'],
    ['EUR', 'es', 'La Jacket cuesta de 1200 euros a 5000.'],
  ])('%s %s: the upper bound of "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('A2. a later word never overrides the currency next to the number', () => {
  it.each([
    ['EUR', 'en', 'The Jacket ships at 1200 EUR for all orders.'],
    ['EUR', 'en', 'The Jacket is 1200 euros for all orders.'],
    ['EUR', 'en', 'The Jacket is 1200 EUR per cup of coffee.'],
    ['USD', 'en', 'The Jacket is 1200 USD on top.'],
  ])('%s %s: the real price in "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it.each([
    ['EUR', 'en', 'It has 2 straps in real leather.'],
    ['EUR', 'en', 'Lined with 2 layers of real down.'],
    ['EUR', 'en', 'Apply 2 drops and rub in.'],
    ['EUR', 'fr', 'Elle couvre 10 mètres de mur.'],
    ['EUR', 'fr', 'Les 3 modèles dont ils parlent.'],
    ['EUR', 'es', 'Los 2 colores que ves en la foto.'],
    ['EUR', 'en', 'The mug holds 0.35 l per cup.'],
    ['EUR', 'en', 'Rated 4.8 by all.'],
    ['GBP', 'en', 'Holds 5 kg per pound bag.'],
  ])('%s %s: "%s" has no money', (currency, language, text) => {
    expect(extractAmounts(text, [language], currency)).toHaveLength(0);
  });
});

describe('A3. the stated currency wins over a later currency word', () => {
  it('"12 dollars per pound" in a GBP store is dollars', () => {
    expect(
      extractAmounts('The Jacket is 12 dollars per pound.', ['en'], 'GBP')[0]?.currencies,
    ).not.toContain('GBP');
  });
});

describe('security review: two currencies in one token fail closed', () => {
  it('a qualifier pair whose words disagree matches nothing', () => {
    // "Swiss" is no currency; "Indian dollars" reads the noun; a sterling pair reads the noun.
    // A qualifier pins its currency, and a noun that cannot be that currency is no money.
    expect(extractAmounts('1200 Canadian dollars', ['en'], 'EUR')[0]?.currencies).toEqual(['CAD']);
    expect(extractAmounts('1200 Indian dollars', ['en'], 'EUR')).toHaveLength(0);
    expect(extractAmounts('1200 pounds sterling', ['en'], 'EUR')[0]?.currencies).toEqual(['GBP']);
  });
});

describe('B1. yen and yuan stay apart', () => {
  it.each([
    ['CNY', 'en', 'The Jacket is 1200 yen.'],
    ['JPY', 'en', 'The Jacket is 1200 yuan.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});
