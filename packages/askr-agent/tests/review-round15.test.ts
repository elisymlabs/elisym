import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { sanitizeText } from '../src/fence';
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

function storeWith(title: string, currency: string, language: string) {
  const jacket = item({ d: 'jacket', title, price: { amount: '1200', currency } });
  return new StoreCatalog({ ...CONFIG, currency, language }, undefined, [jacket], []);
}

describe('A1. a second word only for the fixed two-word names', () => {
  it.each([
    ['RUB', 'ru', 'Серьги за 1990 руб стерлинговое серебро 925 пробы.'],
    ['RUB', 'ru', 'Серьги: 1990 р стерлинговое серебро.'],
    ['GBP', 'ru', 'Серьги за 1990 фунтов стерлингового серебра.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('a guide heading and body never join into one currency word', () => {
    const store = storeWith('Jacket', 'RUB', 'ru');
    expect(
      checkPrices(
        {
          ...answer(''),
          components: [
            {
              type: 'guide',
              title: 'Guide',
              sections: [
                { heading: 'Серьги за 1990 руб', body: 'Стерлинговое серебро 925 пробы.' },
              ],
            },
          ],
        } as Answer,
        {
          storeCurrency: 'RUB',
          items: store.items,
          visitorMessages: [],
          policyPassages: [],
          locales: ['ru', 'ru'],
        },
      ),
    ).toHaveLength(1);
  });

  it('a currency word before "стерлинговое" keeps its currency', () => {
    expect(
      extractAmounts('5000 рублей стерлинговое серебро', ['ru'], 'USD')[0]?.currencies,
    ).toEqual(['RUB']);
  });
});

describe('A2. titles are compared like the model sees them', () => {
  it.each(['Heart Mug ❤\ufe0f', 'Super\u00adJacke'])('a real price of "%s" passes', (title) => {
    const store = storeWith(title, 'EUR', 'en');
    const shown = sanitizeText(title, 200);
    expect(
      checkPrices(answer(`The ${shown} costs 1200 €.`), {
        storeCurrency: 'EUR',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['en', 'en'],
      }),
    ).toHaveLength(0);
  });

  it('search finds a title with a soft hyphen', () => {
    const store = storeWith('Winter\u00adjacke', 'EUR', 'de');
    expect(store.scores(sanitizeText('Winter\u00adjacke', 200)).get('jacket') ?? 0).toBeGreaterThan(
      0,
    );
  });
});

describe('B. coverage', () => {
  it.each([
    ['EUR', 'de', 'Das sind 1200 US-Dollar.'],
    ['EUR', 'ru', 'Это около 1500 франков.'],
    ['EUR', 'uk', 'Це приблизно 1500 франків.'],
    ['EUR', 'ru', 'Это около 1500 швейцарских франков.'],
    ['EUR', 'de', 'Das sind 1500 Schweizer Franken.'],
    ['EUR', 'de', 'Das sind 1500 Rubel.'],
    ['EUR', 'es', 'Son 1500 rublos.'],
    ['EUR', 'pl', 'To 1500 rubli.'],
    ['EUR', 'nl', 'Dat is 1500 roebel.'],
    ['UAH', 'uk', 'Це 1500 рублів.'],
    ['EUR', 'ru', 'Это 1500 злотых.'],
    ['EUR', 'uk', 'Це 1500 злотих.'],
    ['USD', 'uk', 'Це 1500 гривнями.'],
  ])('%s %s: a converted price "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('SFr. is francs in a CHF store', () => {
    expect(violationsIn('CHF', 'de-CH', 'Nur SFr. 1299 heute.')).toBe(1);
    expect(violationsIn('CHF', 'de-CH', 'Nur SFr 1299 heute.')).toBe(1);
  });

  it('"Schweizer Uhren" is not a currency word', () => {
    expect(extractAmounts('1500 Schweizer Uhren', ['de'], 'EUR')).toHaveLength(0);
  });
});

describe('test gaps', () => {
  it("a visitor's francs match the model's CHF in a non-CHF store", () => {
    expect(
      violationsIn('EUR', 'en', 'Yes, CHF 100 is right.', { visitor: ['I have 100 francs'] }),
    ).toBe(0);
  });

  it('Dutch "à" is not a range word in German', () => {
    expect(violationsIn('EUR', 'de', 'Jacket: 2 à 1200 €')).toBe(0);
  });
});
