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

function catalogCheck(text: string, policies: string[] = []) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency: 'USD' } });
  const iphoneCase = item({
    d: 'case',
    title: 'iPhone Case',
    price: { amount: '30', currency: 'USD' },
  });
  const battery = item({
    d: 'battery',
    title: 'eBike Battery',
    price: { amount: '300', currency: 'USD' },
  });
  const store = new StoreCatalog(
    { ...CONFIG, currency: 'USD', language: 'en' },
    undefined,
    [jacket, iphoneCase, battery],
    [],
  );
  return checkPrices(answer(text), {
    storeCurrency: 'USD',
    items: store.items,
    visitorMessages: [],
    policyPassages: policies,
    locales: ['en', 'en'],
  }).length;
}

describe('A1-A2. U.S. and the sentence split', () => {
  it.each([
    ['USD', 'The Jacket costs 999 U.S. Dollars.'],
    ['EUR', 'The Jacket costs 999 U.S. Dollars.'],
    ['USD', 'The Jacket costs 999 U.S. Dollar.'],
    ['USD', 'The Jacket costs 999 U.S. Dollars and ships free.'],
    ['USD', 'The Jacket costs 999 U.S. DOLLARS.'],
  ])('%s: "%s" is caught', (currency, text) => {
    expect(violationsIn(currency, 'en', text)).toBe(1);
  });

  it('the real price in "1200 U.S. Dollars" passes', () => {
    expect(violationsIn('USD', 'en', 'The Jacket costs 1200 U.S. Dollars.')).toBe(0);
  });

  it.each([
    'We ship the Jacket across the U.S. iPhone Case: $1200.',
    'The Jacket ships within the U.S. eBike Battery is $1200.',
  ])('a camel-case product after "U.S." starts its own sentence: "%s"', (text) => {
    expect(catalogCheck(text)).toBe(1);
  });
});

describe('A3. a word after a noun that cannot take it is no qualifier', () => {
  it.each([
    'Livraison offerte dès 100 € Suisse comprise.',
    'La Jacket coûte 1200 euros Suisse comprise.',
  ])('"%s" reads euros', (text) => {
    expect(extractAmounts(text, ['fr'], 'EUR')[0]?.currencies).toEqual(['EUR']);
  });

  it('a policy shipping row repeated in the answer passes', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Jacket',
      price: { amount: '1200', currency: 'EUR' },
    });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'EUR', language: 'fr' },
      undefined,
      [jacket],
      [],
    );
    expect(
      checkPrices(answer('La Jacket coûte 1200 €. Livraison : 9 € France, 19 € Suisse.'), {
        storeCurrency: 'EUR',
        items: store.items,
        visitorMessages: [],
        policyPassages: ['Livraison : 9 € France, 19 € Suisse.'],
        locales: ['fr', 'fr'],
      }),
    ).toHaveLength(0);
  });

  it('a preposed qualifier the noun cannot be still fails closed', () => {
    expect(extractAmounts('1200 Indian dollars', ['en'], 'EUR')[0]?.currencies).toEqual([]);
  });
});

describe('A4. a postposed word after a qualified token keeps the token', () => {
  it.each([
    ['The Jacket is 1200 Swiss francs American Express accepted.', 'CHF'],
    ['The Jacket is 1200 Canadian dollars American shipping.', 'CAD'],
  ])('"%s" reads %s', (text, expected) => {
    expect(extractAmounts(text, ['en'], 'EUR')[0]?.currencies).toEqual([expected]);
  });
});

describe('A5. Brazilian real', () => {
  it('is BRL after its qualifier, and "Chinese real silk" is no money', () => {
    expect(violationsIn('USD', 'en', 'The Jacket is 1200 Brazilian real.')).toBe(1);
    expect(extractAmounts('Includes 2 Chinese real silk scarves.', ['en'], 'EUR')).toHaveLength(0);
  });
});

describe('A6. an ISO code after the noun pins it', () => {
  it.each([
    ['USD', 'en', 'The Jacket is 1200 dollars CAD.'],
    ['USD', 'en', 'The Jacket is 1200 dollars AUD.'],
    ['MXN', 'es', 'La Jacket cuesta 1200 pesos ARS.'],
    ['USD', 'en', 'The Jacket is 1200 $ CAD.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('a known code the noun cannot be contradicts it and fails closed', () => {
    expect(violationsIn('USD', 'en', 'The Jacket is 1200 dollars EUR style.')).toBe(1);
  });
});

describe('B. coverage', () => {
  it.each([
    ['EUR', 'de', 'Das sind 1200 dänische Kronen.'],
    ['EUR', 'de', 'Das sind 1200 schwedische Kronen.'],
    ['EUR', 'nl', 'Dat is 1200 Deense kronen.'],
    ['EUR', 'en', 'That is 1200 Czech korunas.'],
    ['EUR', 'en', 'That is 1200 rupiah.'],
    ['EUR', 'en', 'That is 1200 ringgit.'],
    ['EUR', 'en', 'That is 1200 renminbi.'],
    ['EUR', 'en', 'That is 1200 South African rands.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('an XOF store reads "francs suisses" as CHF', () => {
    expect(extractAmounts('1200 francs suisses', ['fr'], 'XOF')[0]?.currencies).toEqual(['CHF']);
  });

  it('a range after a postposed qualifier on a symbol keeps both bounds', () => {
    expect(extractAmounts('de 1100 $ canadienses a 1300', ['es'], 'USD')).toHaveLength(2);
  });
});
