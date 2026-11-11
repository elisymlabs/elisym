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

describe('A1. a magnitude abbreviation does not end the sentence', () => {
  it.each([
    ['EUR', 'de', 'Die Jacket kostet 1,2 Tsd. € bis 1,5 Tsd. €.'],
    ['EUR', 'de', 'Handschuhe kosten 1,3 Tsd. €.'],
    ['RUB', 'ru', 'Jacket стоит 1,5 тыс. ₽.'],
    ['RUB', 'ru', 'Перчатки стоят 1,3 тыс. ₽ за пару.'],
    ['RUB', 'ru', 'Jacket стоит от 1,2 до 1,5 тыс. ₽.'],
    ['EUR', 'de', 'Die Jacket kostet 1,5 Mio. €.'],
    ['RUB', 'ru', 'Jacket: 1,3 млн. ₽.'],
    ['UAH', 'uk', 'Jacket коштує 1,5 тис. грн.'],
    ['PLN', 'pl', 'Jacket kosztuje 1,5 tys. zł.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('a real price with a magnitude abbreviation passes', () => {
    expect(violationsIn('RUB', 'ru', 'Jacket стоит 1,2 тыс. ₽.')).toBe(0);
  });
});

describe('A2. only the currency noun of a store name is money', () => {
  it.each([
    ['NZD', 'en', 'We have 3 new colors.'],
    ['USD', 'fr', 'Choisissez 2 des 5 couleurs.'],
    ['UAH', 'uk', 'Маємо понад 100 українських брендів.'],
    ['RUB', 'ru', 'У нас 5 российских брендов.'],
    ['PLN', 'pl', 'Mamy 5 polskich marek.'],
    ['CHF', 'en', 'We ship to all 26 Swiss cantons.'],
    ['CHF', 'de', 'Wir haben 3 Schweizer Filialen.'],
    ['CAD', 'en', 'We cover 10 Canadian provinces.'],
    ['JPY', 'en', 'We carry 5 Japanese brands.'],
    ['HKD', 'en', 'We have 7 Hong Kong stores.'],
    ['ZAR', 'en', 'We have 9 South African stores.'],
    ['USD', 'nl', 'We hebben 5 Amerikaanse merken.'],
    ['CZK', 'cs', 'Máme 5 českých značek.'],
    ['SEK', 'sv', 'Vi har 5 svenska märken.'],
    ['USD', 'en', 'We have 5 US stores.'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it.each([
    ['PLN', 'pl', 'Jacket kosztuje 1500 złotych.'],
    ['CZK', 'cs', 'Jacket stojí 1500 korun.'],
    ['CZK', 'cs', 'Jacket stojí 2 koruny.'],
    ['NZD', 'en', 'The Jacket is 1500 dollars.'],
  ])('%s %s: the noun in "%s" is still money', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('A3. hyphen and non-breaking hyphen are range dashes', () => {
  it.each([
    'The Jacket is $1200‑1500.',
    'The Jacket is $1200 ‑ 1500.',
    'The Jacket is $1200‐1500.',
  ])('"%s" is caught', (text) => {
    expect(violationsIn('USD', 'en', text)).toBe(1);
  });
});

describe('A4. a shared trailing magnitude', () => {
  it.each([
    ['RUB', 'ru', 'Jacket: 1,2–1,5 тыс. ₽', '1200'],
    ['USD', 'en', 'Jacket: $1.2-1.5k', '1200'],
    ['USD', 'en', 'Jacket: 1.2-1.5k USD', '1200'],
  ])('%s %s: "%s" reads the lower bound as %s too', (currency, language, text, value) => {
    expect(valuesOf(text, language, currency).flat()).toContain(value);
  });

  it('a true range with a shared magnitude passes', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Jacket',
      price: { amount: '1200', currency: 'USD' },
    });
    const coat = item({ d: 'coat', title: 'Coat', price: { amount: '1500', currency: 'USD' } });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'USD', language: 'en' },
      undefined,
      [jacket, coat],
      [],
    );
    expect(
      checkPrices(answer('The Jacket and the Coat cost $1.2-1.5k.'), {
        storeCurrency: 'USD',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['en', 'en'],
      }),
    ).toHaveLength(0);
  });
});

describe('A5. test gaps', () => {
  it.each([
    ['USD', 'en', 'Jacket: 1000 to about $1200'],
    ['EUR', 'de', 'Jacket: 1000 bis ca. 1200 €'],
    ['EUR', 'de', 'Jacket: zwischen ca 1000 und 1200 €'],
    ['USD', 'en', 'Jacket: $1200 up to 1500'],
    ['USD', 'en', 'Jacket: $1000 To 1200'],
    ['EUR', 'de', 'Jacket: 1000 Bis 1200 €'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('an en dash after a closing symbol does not open the next number', () => {
    expect(violationsIn('EUR', 'de', 'Jacket 1200 € – 2 Farben')).toBe(0);
    expect(violationsIn('USD', 'en', 'Jacket model 2024 – $1200')).toBe(0);
  });

  it('a lent symbol is normalized first', () => {
    expect(violationsIn('INR', 'en-IN', 'Only Ｒｓ. 999 today')).toBe(1);
  });
});

describe('B. coverage', () => {
  it.each([
    ['EUR', 'nl', 'Jacket kost van 1000 tot 1200 euro.'],
    ['EUR', 'nl', 'Jacket kost 1000 tot 1200 euro.'],
    ['EUR', 'nl', 'Jacket kost tussen de 1000 en 1200 euro.'],
    ['BRL', 'pt', 'A Jacket custa de 1000 até 1200 reais.'],
    ['EUR', 'es', 'La Jacket cuesta desde 1000 hasta 1200 euros.'],
    ['EUR', 'it', 'La Jacket costa tra i 1000 e i 1200 euro.'],
    ['EUR', 'it', 'La Jacket costa dai 1000 ai 1200 euro.'],
    ['EUR', 'es', 'La Jacket cuesta entre los 1000 y los 1200 euros.'],
    ['BRL', 'pt', 'A Jacket custa entre os 1000 e os 1200 reais.'],
    ['EUR', 'de', 'Die Jacket kostet zwischen rund 1000 und 1200 Euro.'],
    ['PLN', 'pl', 'Jacket kosztuje od około 1000 do 1200 zł.'],
    ['PLN', 'pl', 'Jacket kosztuje ok. 999 zł.'],
    ['EUR', 'fr', "La Jacket coûte de 1000 jusqu'à 1200 €."],
    ['USD', 'en', 'Jacket: $1200 through 1500'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['EUR', 'de', '2 Tausend Euro', '2000'],
    ['EUR', 'es', '2 millones de euros', '2000000'],
    ['EUR', 'de', '2 Millionen Euro', '2000000'],
    ['EUR', 'fr', "2 millions d'euros", '2000000'],
    ['EUR', 'fr', '2 mille euros', '2000'],
    ['EUR', 'it', '2 mila euro', '2000'],
    ['EUR', 'it', '2 milioni di euro', '2000000'],
    ['EUR', 'nl', '2 duizend euro', '2000'],
  ])('%s %s: "%s" reads %s', (currency, language, text, value) => {
    expect(valuesOf(text, language, currency).flat()).toContain(value);
  });

  it('"de" stays an opener when no opener stands before it', () => {
    expect(violationsIn('EUR', 'es', 'La Jacket de 999 a 1200 €')).toBe(1);
  });
});
