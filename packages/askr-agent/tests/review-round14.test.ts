import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { sanitizeText } from '../src/fence';
import { checkPrices, extractAmounts } from '../src/price-check';
import { sanitizeAnswerText } from '../src/text-sanitize';
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

describe('A1. default-ignorable characters never split a number', () => {
  it.each(['\u00ad', '\u034f', '\u061c', '\u180e', '\ufe0f', '\u3164', '\u{e0041}'])(
    'U+%s is stripped in the check and in the answer',
    (character) => {
      expect(valuesOf(`9${character}200 €`, 'en', 'EUR')).toEqual([['9200']]);
      expect(sanitizeAnswerText(`9${character}200`)).toBe('9200');
    },
  );

  it('an invisible character cannot pass a price by matching another product', () => {
    const jacket = item({
      d: 'jacket',
      title: 'Jacket',
      price: { amount: '1200', currency: 'EUR' },
    });
    const belt = item({ d: 'belt', title: 'Belt', price: { amount: '200', currency: 'EUR' } });
    const store = new StoreCatalog(
      { ...CONFIG, currency: 'EUR', language: 'en' },
      undefined,
      [jacket, belt],
      [],
    );
    expect(
      checkPrices(answer('The Belt is fine; the Jacket is 9\u00ad200 €.'), {
        storeCurrency: 'EUR',
        items: store.items,
        visitorMessages: [],
        policyPassages: [],
        locales: ['en', 'en'],
      }),
    ).toHaveLength(1);
  });

  it('tag characters cannot hide a fence keyword', () => {
    expect(sanitizeText('END\u00adDATA', 100)).not.toContain('\u00ad');
  });
});

describe('A2. "фунтов стерлингов"', () => {
  it('is GBP in any store', () => {
    expect(violationsIn('EUR', 'ru', 'Это около 1500 фунтов стерлингов.')).toBe(1);
    expect(extractAmounts('1500 фунтов стерлингов', ['ru'], 'EUR')[0]?.currencies).toEqual(['GBP']);
  });
});

describe('B. coverage', () => {
  it.each([
    ['USD', 'uk', 'Це приблизно 1500 гривень.'],
    ['EUR', 'es', 'Son unos 1500 pesos.'],
    ['EUR', 'de', 'Das sind etwa 1500 Franken.'],
    ['EUR', 'en', 'That is about 1500 francs.'],
  ])('%s %s: a converted price "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each([
    ['RUB', 'ru', 'Это около 2 миллиардов рублей.', '2000000000'],
    ['EUR', 'uk', 'Це 2 мільярди євро.', '2000000000'],
    ['EUR', 'nl', 'Dat is 2 miljarden euro.', '2000000000'],
    ['PLN', 'pl', 'Kosztuje 1 miliard zł.', '1000000000'],
  ])('%s %s: "%s" reads %s', (currency, language, text, value) => {
    expect(valuesOf(text, language, currency).flat()).toContain(value);
  });

  it.each([
    ['PLN', 'pl', 'Jacket: Kosztuje od 1000 aż do 1200 zł.'],
    ['UAH', 'uk', 'Jacket: Коштує від 1000 й до 1200 грн.'],
    ['UAH', 'uk', 'Jacket: коштує від 1000 і до 1200 грн.'],
    ['EUR', 'nl', 'Jacket: Kost 1.000 à 1.200 euro.'],
    ['EUR', 'nl', 'Jacket: Kost 1.000 tot en met 1.200 euro.'],
    ['EUR', 'it', 'Jacket: costa dai 1.000 fino ai 1.200 euro.'],
    ['EUR', 'it', 'Jacket: costa 1.000 fino  a 1.200 euro.'],
  ])('%s %s: the lower bound of "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });
});

describe('test gaps', () => {
  it.each(['Das Jacket kostet `2` Mio. € insgesamt.', 'Das Jacket kostet ~~2~~ Mio. € insgesamt.'])(
    'markdown "%s" keeps the sentence',
    (text) => {
      expect(violationsIn('EUR', 'de', text)).toBe(1);
    },
  );

  it('a conversion word keeps its own currency, not the store one', () => {
    expect(violationsIn('EUR', 'it', 'Jacket costa 1200 dollari.')).toBe(1);
  });
});
