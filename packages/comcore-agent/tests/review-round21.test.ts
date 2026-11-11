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

function twoProducts(text: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency: 'USD' } });
  const boots = item({ d: 'boots', title: 'Boots', price: { amount: '900', currency: 'USD' } });
  const store = new StoreCatalog(
    { ...CONFIG, currency: 'USD', language: 'en' },
    undefined,
    [jacket, boots],
    [],
  );
  return checkPrices(answer(text), {
    storeCurrency: 'USD',
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: ['en', 'en'],
  }).length;
}

describe('A1. a letter symbol after a qualifier is money', () => {
  it.each([
    ['EUR', 'The Jacket is 1200 Swedish kr.'],
    ['EUR', 'The Jacket is 1200 Polish zł.'],
    ['EUR', 'The Jacket is 1200 Czech Kč.'],
    ['EUR', 'The Jacket is 1200 Indian Rs.'],
    ['NOK', 'The Jacket costs 1200 Danish kroner.'],
    ['DKK', 'The Jacket costs 1200 Norwegian kroner.'],
    ['NOK', 'The Jacket costs 1200 Swedish kr.'],
  ])('%s: "%s" is caught', (currency, text) => {
    expect(violationsIn(currency, 'en', text)).toBe(1);
  });

  it('a qualifier naming the store currency passes its real price', () => {
    expect(violationsIn('NOK', 'en', 'The Jacket costs 1200 Norwegian kroner.')).toBe(0);
  });
});

describe('A2. "U.S." ends a sentence before a capital word', () => {
  it.each([
    'The Jacket ships only within the U.S. The Boots cost 1200 $.',
    'The Jacket is made in the U.S. The Boots are 1200 USD.',
    'We ship the Jacket across the U.S. Boots: $1200.',
  ])('"%s" is caught', (text) => {
    expect(twoProducts(text)).toBe(1);
  });

  it('"U.S." before a line break never joins the next line', () => {
    expect(twoProducts('The Jacket is made in the U.S.\nboots cost $1200.')).toBe(1);
  });

  it('"999 U.S. dollars" stays one sentence', () => {
    expect(violationsIn('USD', 'en', 'The Jacket is 999 U.S. dollars.')).toBe(1);
  });
});

describe('B1-B3. qualified nouns, stems and postposed qualifiers', () => {
  it.each([
    ['EUR', 'en', 'The Jacket is 999 New Taiwan dollars.'],
    ['USD', 'en', 'The Jacket is 1200 New Taiwan dollars.'],
    ['EUR', 'en', 'The Jacket is 999 South African rand.'],
    ['EUR', 'en', 'The Jacket is 999 South Korean won.'],
    ['EUR', 'en', 'The Jacket is 999 Thai baht.'],
    ['EUR', 'en', 'The Jacket is 999 Hungarian forints.'],
    ['EUR', 'en', 'The Jacket is 999 Israeli shekels.'],
    ['EUR', 'en', 'The Jacket is 999 Swedish kronor.'],
    ['EUR', 'en', 'The Jacket is 999 Chilean pesos.'],
    ['EUR', 'en', 'The Jacket is 999 Hongkong dollars.'],
    ['USD', 'es', 'La Jacket cuesta 1200 dólares canadienses.'],
    ['MXN', 'es', 'La Jacket cuesta 1200 pesos argentinos.'],
    ['USD', 'fr', 'La Jacket coûte 1200 dollars canadiens.'],
    ['USD', 'en', 'The Jacket is 1200 dollars Canadian.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('"the team won" is no money', () => {
    expect(extractAmounts('A team of 5 won the award.', ['en'], 'EUR')).toHaveLength(0);
  });

  it('a French "dans" after an amount is no qualifier', () => {
    expect(violationsIn('EUR', 'fr', 'La Jacket coûte 1200 euros dans notre boutique.')).toBe(0);
  });
});

describe('each qualifier pins its own currency', () => {
  it.each([
    ['NZD', 'en', 'The Jacket is 1200 NZ dollars.'],
    ['SGD', 'en', 'The Jacket is 1200 Singapore dollars.'],
    ['BRL', 'en', 'The Jacket is 1200 Brazilian reais.'],
    ['ARS', 'en', 'The Jacket is 1200 Argentine pesos.'],
    ['UAH', 'uk', 'Jacket коштує 1200 українських гривень.'],
    ['JPY', 'de', 'Die Jacket kostet 1200 japanische Yen.'],
    ['AUD', 'en', 'The Jacket is 1200 Australian dollars.'],
  ])('%s %s: the real price in "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it.each([
    ['EUR', 'en', 'The Jacket is 1200 NZ dollars.', 'NZD'],
    ['EUR', 'en', 'The Jacket is 1200 Singapore dollars.', 'SGD'],
    ['EUR', 'en', 'The Jacket is 1200 Argentine pesos.', 'ARS'],
    ['EUR', 'en', 'The Jacket is 1200 Australian dollars.', 'AUD'],
  ])('%s %s: "%s" reads %s', (currency, language, text, expected) => {
    expect(extractAmounts(text, [language], currency)[0]?.currencies).toEqual([expected]);
  });

  it("a visitor's qualified amount may be repeated in a store of another dollar", () => {
    expect(
      violationsIn('USD', 'en', 'Yes, 1200 Canadian dollars is right.', {
        visitor: ['Is it 1200 Canadian dollars?'],
      }),
    ).toBe(0);
  });

  it('"English pound cakes" fails closed as pounds (accepted false positive)', () => {
    expect(
      extractAmounts('We bake 2 English pound cakes daily.', ['en'], 'EUR')[0]?.currencies,
    ).toEqual(['GBP']);
  });
});
