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

function violationsIn(currency: string, language: string, text: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
  return checkPrices(answer(text), {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, language],
  });
}

const valuesOf = (text: string, locales: string[], currency?: string) =>
  extractAmounts(text, locales, currency).map((amount) => amount.values.map(String));

describe('1. native digits and Arabic separators', () => {
  it.each([
    ['SAR', 'ar-SA', 'السعر ٥٠ ر.س'],
    ['IRR', 'fa', 'قیمت ۲۰۰ ریال'],
    ['INR', 'hi', 'कीमत ₹९९ है'],
    ['SAR', 'ar-SA', 'السعر ١٢٫٥ ر.س'],
  ])('%s %s: an invented price is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toHaveLength(1);
  });

  it('reads the Arabic decimal sign as a point', () => {
    expect(valuesOf('$١٢٫٥', ['ar-SA'])).toEqual([['12.5']]);
  });

  it('a real price in native digits passes', () => {
    expect(violationsIn('INR', 'hi', 'Jacket: ₹१२००')).toHaveLength(0);
  });
});

describe('2. a symbol ending in a dot glued to the number', () => {
  it.each([
    ['INR', 'en-IN', 'Only Rs.999 today'],
    ['CHF', 'de-CH', 'Nur Fr.99 heute'],
  ])('%s %s: a glued amount is read', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toHaveLength(1);
  });

  it.each([
    ['INR', 'en-IN', 'Only Rs. 999 today'],
    ['CHF', 'de-CH', 'Kostet Fr. 99.'],
  ])('%s %s: a dotted symbol before a space stays with its number', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toHaveLength(1);
  });

  it('a number right after a grouped digit is not split', () => {
    expect(valuesOf('$1,200', ['en'])).toEqual([['1200']]);
  });
});

describe('3. "Fr." is francs only in a CHF store', () => {
  it('opening hours in a EUR store are not an amount', () => {
    expect(violationsIn('EUR', 'de', 'Geöffnet Mo.-Fr. 9-18 Uhr.')).toHaveLength(0);
    expect(violationsIn('EUR', 'de', 'Fr. 99')).toHaveLength(0);
  });

  it('a CHF store reads "Fr. 99"', () => {
    expect(violationsIn('CHF', 'de-CH', 'Kostet Fr. 99.')).toHaveLength(1);
  });
});

describe('4. markdown emphasis', () => {
  it('"$**99**" is read', () => {
    expect(violationsIn('USD', 'en', 'Now only $**99**!')).toHaveLength(1);
    expect(violationsIn('USD', 'en', 'Now only `$99`')).toHaveLength(1);
  });
});

describe('5. a dash for no cents', () => {
  it.each(['99,- €', '99,– €', '99.- CHF'])('"%s" is 99', (text) => {
    expect(valuesOf(text, ['de'])).toContainEqual(['99']);
  });

  it('is caught in a EUR store', () => {
    expect(violationsIn('EUR', 'de', 'Jetzt nur 99,- €')).toHaveLength(1);
  });
});

describe('6. ranges carry the currency to the upper bound', () => {
  for (const text of [
    'Jacket: $1200-150',
    'Jacket: $1200 - 150',
    'Jacket: from $1200 to 150',
    'Jacket: $1200–150',
  ]) {
    it(`the upper bound is checked: ${text}`, () => {
      expect(violationsIn('USD', 'en', text)).toHaveLength(1);
    });
  }

  it('a range of real prices passes', () => {
    expect(violationsIn('USD', 'en', 'Jacket: $1200-1200')).toHaveLength(0);
  });
});

describe('7. Indian grouping', () => {
  it('"₹1,23,456" is one amount', () => {
    expect(valuesOf('₹1,23,456', ['en-IN'])).toEqual([['123456']]);
    expect(valuesOf('₹12,34,567.50', ['en-IN'])).toEqual([['1234567.5']]);
  });

  it('is caught in an INR store', () => {
    expect(violationsIn('INR', 'en-IN', 'Only ₹1,23,456')).toHaveLength(1);
  });
});

describe('8. a dotted symbol in a store of another currency', () => {
  it('"₪" written as ש״ח is read in an ILS store', () => {
    expect(violationsIn('ILS', 'he', 'המחיר 99 ש״ח')).toHaveLength(1);
  });
});
