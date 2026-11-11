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

const valuesOf = (text: string, language: string, currency: string) =>
  extractAmounts(text, [language], currency).map((amount) => amount.values.map(String));

describe('A1. markdown around a number before a magnitude abbreviation keeps the sentence', () => {
  it.each([
    ['RUB', 'ru', 'Jacket стоит **1,5** тыс. ₽.'],
    ['RUB', 'ru', 'Jacket стоит _1,5_ тыс. ₽.'],
    ['EUR', 'de', 'Jacket: **1,5** Tsd. € kostet sie.'],
    ['EUR', 'de', 'Das Jacket kostet **2** Mio. € insgesamt.'],
    ['EUR', 'de', 'Das Jacket kostet etwa 2 Mill. €.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('A2-A3. billions in every supported language', () => {
  it.each([
    ['PLN', 'pl', 'Kosztuje 2 mld zł.', '2000000000'],
    ['PLN', 'pl', 'Kosztuje 2 miliardy zł.', '2000000000'],
    ['EUR', 'it', 'Costa 1 miliardo di euro.', '1000000000'],
    ['EUR', 'fr', "Coûte 2 milliards d'euros.", '2000000000'],
    ['EUR', 'pt', 'Custa 2 mil milhões de euros.', '2000000000'],
    ['BRL', 'pt', 'Custa 2 bilhões de reais.', '2000000000'],
    ['EUR', 'es', 'Cuesta 2 mil millones de euros.', '2000000000'],
    ['EUR', 'nl', 'Kost 2 miljard euro.', '2000000000'],
    ['EUR', 'de', 'Das sind etwa 2 Mill. €.', '2000000'],
  ])('%s %s: "%s" reads %s', (currency, language, text, value) => {
    expect(valuesOf(text, language, currency).flat()).toContain(value);
  });
});

describe('test gaps', () => {
  it('an article after a bare tail range word is not a range', () => {
    expect(extractAmounts('Free shipping: $5 to the 50 states.', ['en'], 'USD')).toHaveLength(1);
  });

  it('the head side keeps its own magnitude', () => {
    expect(valuesOf('Цена 1 тыс. – 1,5 млн ₽.', 'ru', 'RUB')).toEqual([['1000'], ['1500000']]);
  });

  it('the head side shares a magnitude only below the written upper number', () => {
    expect(valuesOf('Цена 900–1,5 тыс. ₽.', 'ru', 'RUB')).toEqual([['900'], ['1500']]);
  });
});

describe('B. coverage', () => {
  it.each([
    ['EUR', 'pl', 'To około 300 dolarów.'],
    ['EUR', 'it', 'Sono circa 300 dollari.'],
    ['USD', 'uk', 'Це приблизно 1100 євро.'],
    ['EUR', 'it', 'cioè circa 1100 sterline.'],
  ])('%s %s: a converted price "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['EUR', 'it', 'Jacket: Si va da 1200 € fino a 1300.'],
    ['RUB', 'ru', 'Jacket: От 1200 ₽ и до 1300.'],
  ])('%s %s: the upper bound of "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});
