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

function twoProducts(currency: string, language: string, text: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const boots = item({ d: 'boots', title: 'Boots', price: { amount: '999', currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket, boots], []);
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, language],
  }).length;
}

describe('A1. a suffix token lends its symbol, not its sentence', () => {
  it('"The Jacket is 1200 Rs. 1200 Rs. for the Boots" is caught', () => {
    expect(twoProducts('INR', 'en', 'The Jacket is 1200 Rs. 1200 Rs. for the Boots as well.')).toBe(
      1,
    );
  });

  it('an amount after the lent symbol must start inside it to borrow', () => {
    expect(
      twoProducts('INR', 'en', 'The Jacket is 1200 Rs. ₹1200 is also what the Boots cost.'),
    ).toBe(1);
  });

  it('one amount starting in the lent symbol is enough to borrow', () => {
    expect(twoProducts('INR', 'en', 'The Jacket costs Rs. 1200, the Boots ₹999.')).toBe(0);
  });
});

describe('B1. a nationality adjective before the currency noun', () => {
  it.each([
    ['USD', 'en', 'That is about 1,150 Canadian dollars.'],
    ['EUR', 'en', 'About 1,050 British pounds.'],
    ['EUR', 'en', 'Roughly 1,800 Australian dollars.'],
    ['EUR', 'en', 'About 1,300 Hong Kong dollars.'],
    ['EUR', 'en', 'About 1,300 New Zealand dollars.'],
    ['EUR', 'en', 'About 25,000 Mexican pesos.'],
    ['EUR', 'en', 'About 100,000 Indian rupees.'],
    ['EUR', 'de', 'Etwa 1.300 kanadische Dollar.'],
    ['EUR', 'de', 'Das sind etwa 1.050 britische Pfund.'],
    ['EUR', 'ru', 'Около 1300 канадских долларов.'],
    ['EUR', 'uk', 'Близько 1300 канадських доларів.'],
    ['EUR', 'nl', 'Ongeveer 1.300 Canadese dollar.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['EUR', 'de', 'Das sind etwa 1150 britische Pfund Sterling.'],
    ['EUR', 'de', 'Das sind 1500 Schweizer Franken pro Jahr.'],
  ])('%s %s: a known pair inside three words "%s" is read', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('the first word is the fallback: "1990 руб стерлинговое" reads руб', () => {
    expect(violationsIn('RUB', 'ru', 'Серьги за 1990 руб стерлинговое серебро.')).toBe(1);
  });

  it('"Pfund Sterlingsilber" is not GBP money in a EUR store', () => {
    expect(extractAmounts('Das sind 500 Pfund Sterlingsilber.', ['de'], 'EUR')).toHaveLength(0);
  });

  it('ordinary two-word text after a number is not money', () => {
    expect(extractAmounts('We have 3 new colors and 5 US stores.', ['en'], 'NZD')).toHaveLength(0);
  });
});

describe('B2. plural and other-language yen, yuan, peso and pound forms', () => {
  it.each([
    ['EUR', 'fr', 'Environ 150 000 yens.'],
    ['EUR', 'fr', 'Environ 150 000 yens japonais.'],
    ['EUR', 'es', 'Unos 150.000 yenes.'],
    ['EUR', 'pt', 'Cerca de 150.000 ienes.'],
    ['EUR', 'fr', 'Environ 9 000 yuans.'],
    ['EUR', 'es', 'Unos 9.000 yuanes.'],
    ['EUR', 'ru', 'Около 25 000 мексиканских песо.'],
    ['EUR', 'nl', 'Dat is 1.000 pond sterling.'],
    ['EUR', 'nl', 'Dat is 1.000 Britse ponden.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('yen is JPY only and yuan CNY only', () => {
    expect(violationsIn('CNY', 'en', 'The Jacket is 1200 Japanese yen.')).toBe(1);
    expect(violationsIn('JPY', 'en', 'The Jacket is 1200 Chinese yuan.')).toBe(1);
  });
});
