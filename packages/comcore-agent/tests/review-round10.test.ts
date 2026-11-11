import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { executeTool, newTurnState } from '../src/tools';
import { CONFIG, catalog, item, toolCall } from './fixtures';

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

function guideViolations(heading: string, body: string) {
  const jacket = item({ d: 'jacket', title: 'Jacket', price: { amount: '1200', currency: 'EUR' } });
  const store = new StoreCatalog(
    { ...CONFIG, currency: 'EUR', language: 'en' },
    undefined,
    [jacket],
    [],
  );
  return checkPrices(
    {
      ...answer(''),
      components: [{ type: 'guide', title: 'Guide', sections: [{ heading, body }] }],
    } as Answer,
    {
      storeCurrency: 'EUR',
      items: store.items,
      visitorMessages: [],
      policyPassages: [],
      locales: ['en', 'en'],
    },
  ).length;
}

describe('1. a quantity word ending one sentence does not drop the next lower bound', () => {
  it.each([
    ['de', 'Wählen Sie Ihre Größe. 900 - 1200 € für die Jacket.'],
    ['en', 'Prices vary a lot. 900 - 1200 € for the Jacket.'],
    ['en', 'Ships the next day. 900–1200 € for the Jacket.'],
    ['en', 'It depends on the version. 900-1200 € for the Jacket.'],
  ])('%s: "%s" is caught', (language, text) => {
    expect(violationsIn('EUR', language, text)).toBe(1);
  });

  it('in a guide body and after a guide heading', () => {
    expect(guideViolations('Sizes', 'Pick a size. 900 - 1200 € for the Jacket.')).toBe(1);
    expect(guideViolations('Choose your size', '900 - 1200 € for the Jacket.')).toBe(1);
  });

  it('only a currency symbol is lent to the next sentence, not an abbreviation-like word', () => {
    expect(violationsIn('EUR', 'en', 'I said no. 900 - 1200 € for the Jacket.')).toBe(1);
  });

  it('an article number before a lower bound still passes', () => {
    expect(violationsIn('EUR', 'de', 'Jacket Art. 900 - 1200 €')).toBe(0);
  });
});

describe("2. the store currency's everyday name", () => {
  it.each([
    ['MXN', 'es', 'La Jacket cuesta 1500 pesos.'],
    ['ARS', 'es-AR', 'La Jacket cuesta 1500 pesos.'],
    ['CHF', 'de', 'Die Jacket kostet 1500 Franken.'],
    ['SEK', 'sv', 'Jacket kostar 1500 kronor.'],
    ['DKK', 'da', 'Jacket koster 1500 kroner.'],
    ['CZK', 'cs', 'Jacket stojí 1500 korun.'],
    ['HUF', 'hu', 'A Jacket ára 1500 forint.'],
    ['TRY', 'tr', 'Jacket 1500 lira.'],
    ['IDR', 'id', 'Jacket harganya 1500 rupiah.'],
    ['RUB', 'en', 'The Jacket is 1500 rubles.'],
    ['RUB', 'en', 'The Jacket is 1500 roubles.'],
    ['UAH', 'en', 'The Jacket is 1500 hryvnias.'],
    ['PLN', 'en', 'The Jacket is 1500 zlotys.'],
    ['ILS', 'en', 'The Jacket is 1500 shekels.'],
    ['KRW', 'en', 'The Jacket is 1500 won.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('3. every dash between two numbers', () => {
  it.each([
    ['RUB', 'ru', 'Jacket стоит 900\u20141200 ₽.'],
    ['EUR', 'de', 'Jacket kostet 900\u20141200 €.'],
    ['USD', 'en', 'Jacket: 900−1200 USD'],
    ['USD', 'en', 'Jacket: 900‒1200 USD'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('4. magnitude words', () => {
  it.each([
    ['RUB', 'ru', 'Jacket стоит 1,5 тыс. ₽.', '1500'],
    ['RUB', 'ru', 'Jacket стоит 15 тыс. рублей.', '15000'],
    ['EUR', 'de', 'Jacket kostet 1,5 Tsd. €.', '1500'],
    ['USD', 'en', 'Jacket costs 1.5k USD', '1500'],
    ['EUR', 'en', 'The Jacket is 1.5K €.', '1500'],
    ['USD', 'en', 'It is 2 thousand dollars', '2000'],
    ['BRL', 'pt', 'Custa 2 mil reais', '2000'],
    ['USD', 'en', 'Only $1.2k today', '1200'],
    ['USD', 'en', 'Only $2 million', '2000000'],
  ])('%s %s: "%s" reads %s', (currency, language, text, value) => {
    expect(valuesOf(text, language, currency).flat()).toContain(value);
  });

  it('a lower bound carries its own magnitude', () => {
    expect(valuesOf('Jacket: 1.1k-1.2k USD', 'en', 'USD').flat()).toContain('1100');
  });

  it('a currency word of another store is still money', () => {
    expect(violationsIn('EUR', 'en', 'The Jacket is 1200 lira.')).toBe(1);
  });

  it('a real price with a magnitude passes and a glued k upper bound is read', () => {
    expect(violationsIn('USD', 'en', 'The Jacket is $1.2k.')).toBe(0);
    expect(violationsIn('USD', 'en', 'Jacket costs $1200 - 1.5k')).toBe(1);
  });
});

describe('5. hedges between an opener or range word and a bound', () => {
  it.each([
    ['EUR', 'de', 'Die Jacket kostet zwischen ca. 900 und 1200 €.'],
    ['USD', 'en', 'The Jacket costs between about 900 and 1200 dollars.'],
    ['RUB', 'ru', 'Jacket стоит между примерно 900 и 1200 ₽.'],
    ['EUR', 'es', 'La Jacket cuesta entre unos 900 y 1200 €.'],
    ['USD', 'en', 'Jacket: between $1200 and about 1500'],
    ['USD', 'en', 'Jacket: from $1200 to about 1500'],
    ['EUR', 'de', 'Jacket: von 1200 € bis ca. 1500'],
    ['RUB', 'ru', 'Jacket: от 1200 ₽ до примерно 1500'],
    ['USD', 'en', 'Jacket: from $1200 up to 1500'],
    ['EUR', 'de', 'Jacket: ab 1200 € bis zu 1500'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('6. paired range words in more languages', () => {
  it.each([
    ['EUR', 'it', 'La Jacket costa tra 900 e 1200 €.'],
    ['EUR', 'it', 'La Jacket costa fra 900 e 1200 €.'],
    ['PLN', 'pl', 'Jacket kosztuje od 900 do 1200 zł.'],
    ['PLN', 'pl', 'Jacket kosztuje między 900 a 1200 zł.'],
    ['UAH', 'uk', 'Jacket коштує між 900 та 1200 грн.'],
    ['UAH', 'uk', 'Jacket коштує від 900 до 1200 грн.'],
    ['EUR', 'nl', 'Jacket kost tussen 900 en 1200 €.'],
    ['EUR', 'pt', 'Jacket custa entre 900 e 1200 €.'],
    ['EUR', 'fr', 'Jacket coûte entre 900 et 1200 €.'],
    ['EUR', 'en', 'Jacket from du 900 à 1200 €.'],
    ['EUR', 'en', 'Jacket da 900 a 1200 €.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('7. test gaps', () => {
  it.each([
    'Jacket costs $1200 - 2026 collection',
    'Jacket costs $1200 - 2026 season',
    'Jacket costs $1200 - 2026 model',
  ])('an edition word: "%s" passes', (text) => {
    expect(violationsIn('USD', 'en', text)).toBe(0);
  });

  it('a 4-digit lower bound that is not a year is read before a spaced dash', () => {
    expect(violationsIn('USD', 'en', 'Jacket 1100 - $1200')).toBe(1);
  });

  it('a word ending in an abbreviation still ends its sentence', () => {
    expect(violationsIn('USD', 'en', 'We ship to Africa. $5 more for the Jacket.')).toBe(1);
  });

  it.each([
    ['EUR', 'de', 'Die Jacket kostet inkl. 999 €.'],
    ['EUR', 'de', 'Die Jacket kostet zzgl. 999 €.'],
    ['RUB', 'ru', 'Jacket стоит прибл. 999 ₽.'],
    ['RUB', 'ru', 'Jacket стоит ок. 999 ₽.'],
  ])('%s %s: an abbreviation dot keeps "%s" in one sentence', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['EUR', 'de', 'Die Jacket kostet inkl. 1200 €.'],
    ['RUB', 'ru', 'Jacket стоит прибл. 1200 ₽.'],
    ['RUB', 'ru', 'Jacket арт. 1200 ₽.'],
  ])('%s %s: "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it('Russian day units are not money', () => {
    expect(extractAmounts('5 ₽ до 10 дней', ['ru'], 'RUB')).toHaveLength(1);
    expect(extractAmounts('5 ₽ до 10 дня', ['ru'], 'RUB')).toHaveLength(1);
  });

  it('fiyat names the price row', () => {
    const state = newTurnState(new Set(['jacket-wool', 'jacket-rain']), []);
    executeTool(
      catalog(),
      state,
      toolCall('present_comparison', {
        ids: ['jacket-wool', 'jacket-rain'],
        rows: [
          { dimension: 'Fiyat', cells: ['a', 'b'] },
          { dimension: 'Warmth', cells: ['high', 'low'] },
        ],
      }),
    );
    const component = state.components[0];
    expect(
      component?.type === 'comparison' ? component.rows.map((row) => row.dimension) : [],
    ).toEqual(['Price', 'Warmth']);
  });
});
