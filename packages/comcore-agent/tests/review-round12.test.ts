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

describe('A1. a magnitude is shared only by an accepted range, as one reading', () => {
  it.each([
    ['USD', 'en', 'The Jacket costs $1.2 and 5k people love it.'],
    ['USD', 'en', 'Jacket: $1.2 - 5k people bought it.'],
    ['USD', 'en', 'Jacket: $1.2 – 2k km of trails.'],
    ['EUR', 'de', 'Jacket kostet 1,2 € und 3 Tsd. Kunden lieben sie.'],
    ['RUB', 'ru', 'Jacket стоит 1,2 ₽ и 3 тыс. отзывов.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('the shared reading replaces the written one, never adds to it', () => {
    expect(valuesOf('$1.2-1.5k', 'en', 'USD')).toEqual([['1200'], ['1500']]);
    expect(valuesOf('1,2–1,5 тыс. ₽', 'ru', 'RUB')).toEqual([['1200'], ['1500']]);
  });

  it('a lower number above the written upper one keeps its own reading', () => {
    expect(valuesOf('$900-1.5k', 'en', 'USD')).toEqual([['900'], ['1500']]);
  });

  it('own magnitudes on both bounds are not multiplied again', () => {
    expect(valuesOf('1 тыс. – 1,5 тыс. ₽', 'ru', 'RUB')).toEqual([['1000'], ['1500']]);
    expect(valuesOf('$1k-1.5k', 'en', 'USD')).toEqual([['1000'], ['1500']]);
    expect(valuesOf('$1k-1500k', 'en', 'USD')).toEqual([['1000'], ['1500000']]);
  });
});

describe('A2. the currency noun, never an acronym', () => {
  it.each([
    ['AED', 'ru', 'Куртка стоит 1500 дирхамов.'],
    ['AED', 'uk', 'Куртка коштує 1500 дирхамів.'],
  ])('%s %s: "%s" is read', (currency, language, text) => {
    expect(extractAmounts(text, [language], currency)).toHaveLength(1);
  });

  it('a language of unknown word order fails closed on every word of the name', () => {
    // Finnish is in neither word-order list: "Sveitsin frangia" gives both words.
    expect(extractAmounts('5 Sveitsin kauppaa', ['fi'], 'CHF')).toHaveLength(1);
    expect(extractAmounts('5 Swiss stores', ['en'], 'CHF')).toHaveLength(0);
  });

  it('a language of unknown word order still reads the store currency name', () => {
    expect(violationsIn('CHF', 'xx', 'The Jacket is 1500 francs.')).toBe(1);
  });
});

describe('A3. ok. and mio. end a sentence again', () => {
  it.each([
    ['USD', 'en', 'The Jacket fits ok. Gloves cost $1200.'],
    ['EUR', 'it', 'La Jacket è il mio. I guanti costano 1200 €.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('"ok." before a number stays in the sentence', () => {
    expect(violationsIn('PLN', 'pl', 'Jacket kosztuje ok. 1200 zł.')).toBe(0);
    expect(violationsIn('PLN', 'pl', 'Jacket kosztuje od ok. 1000 do 1200 zł.')).toBe(1);
  });
});

describe('A4. an article after a range word only inside an opened range', () => {
  it.each([
    ['USD', 'en', 'Compare these 2 to the $1200 Jacket.'],
    ['USD', 'en', 'Add 1 to the $1200 Jacket order.'],
    ['EUR', 'es', 'Jacket: añade 2 a los 1200 € del pedido.'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  // Fail closed: after a real opener ("from", "de") the article reads as a range.
  it.each([
    ['USD', 'en', 'Go from 3 to the $1200 Jacket.'],
    ['EUR', 'fr', 'Jacket: passez de 2 à les 1200 €.'],
    ['EUR', 'it', 'La Jacket costa tra circa i 1000 e i 1200 €.'],
    ['EUR', 'de', 'Die Jacket kostet zwischen den 1000 und 1200 €.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('test gaps and coverage', () => {
  it.each([
    ['EUR', 'nl', 'Jacket kost vanaf 1000 - 1200 euro.'],
    ['EUR', 'fr', 'La Jacket coûte de 1000 jusqu’à 1200 €.'],
    ['USD', 'en', 'Jacket: 1000⁃1200 USD'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['EUR', 'fr', '2 millions d’euros', '2000000'],
    ['PLN', 'pl', '1,5 mln. zł', '1500000'],
    ['EUR', 'es', '1 millón de euros', '1000000'],
    ['BRL', 'pt', '1 milhão de reais', '1000000'],
    ['EUR', 'it', '1 milione di euro', '1000000'],
    ['EUR', 'nl', '1 miljoen euro', '1000000'],
    ['PLN', 'pl', '1 milion zł', '1000000'],
    ['PLN', 'pl', '2 tysiące zł', '2000'],
    ['PLN', 'pl', '5 tysięcy złotych', '5000'],
    ['EUR', 'de', '2 Mrd. €', '2000000000'],
    ['RUB', 'ru', '1,5 млрд ₽', '1500000000'],
    ['USD', 'en', '$5bn', '5000000000'],
  ])('%s %s: "%s" reads %s', (currency, language, text, value) => {
    expect(valuesOf(text, language, currency).flat()).toContain(value);
  });

  it('a magnitude abbreviation after a number keeps the sentence', () => {
    expect(violationsIn('PLN', 'pl', 'Jacket kosztuje 1,5 mln. zł.')).toBe(1);
  });
});
