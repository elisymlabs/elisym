import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog, StoreCatalog as Catalog, tokenize } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { CONFIG, item, expectLinear } from './fixtures';

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

describe('A1. a lent symbol keeps its sentence as product context', () => {
  it.each([
    ['INR', 'en', 'The Jacket costs Rs. 1200.'],
    ['CHF', 'de', 'Die Jacket kostet Fr. 1200.'],
    ['CHF', 'de', 'Die Jacket kostet SFr. 1200.'],
  ])('%s %s: the real price in "%s" passes', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(0);
  });

  it('an invented price after a lent symbol is still caught', () => {
    expect(violationsIn('INR', 'en', 'The Jacket costs Rs. 999.')).toBe(1);
  });
});

describe('A2. a bare franc word is ambiguous, never only CHF', () => {
  it('an XOF store reads франков as its own currency', () => {
    expect(extractAmounts('1200 франков', ['fr', 'fr'], 'XOF')[0]?.currencies).toContain('XOF');
  });

  it('"франкфуртских" is not a currency word', () => {
    expect(violationsIn('RUB', 'ru', 'К куртке 100 франкфуртских сосисок.')).toBe(0);
  });
});

describe('B1. two-word and conversion names in more languages', () => {
  it.each([
    ['EUR', 'en', 'That is 1150 Swiss francs.'],
    ['EUR', 'uk', 'Це 1150 фунтів стерлінгів.'],
    ['EUR', 'es', 'Son 1150 francos suizos.'],
    ['EUR', 'it', 'Sono 1150 franchi svizzeri.'],
    ['EUR', 'pl', 'To 1150 franków szwajcarskich.'],
    ['EUR', 'nl', 'Dat is 1150 Zwitserse frank.'],
    ['EUR', 'ru', 'Это 1150 йен.'],
    ['EUR', 'uk', 'Це 1150 єн.'],
    ['EUR', 'pl', 'To 1150 hrywien.'],
    ['EUR', 'uk', 'Це 1150 швейцарських франків.'],
  ])('%s %s: a converted price "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it('a two-word name never spans a line break', () => {
    expect(extractAmounts('1500 Schweizer\nFranken', ['de'], 'EUR')).toHaveLength(0);
  });
});

describe('A3. search text is normalized', () => {
  it('a fullwidth query finds the product', () => {
    const store = new Catalog(
      { ...CONFIG, currency: 'EUR', language: 'en' },
      undefined,
      [item({ d: 'jacket', title: 'Winter jacket', price: { amount: '1200', currency: 'EUR' } })],
      [],
    );
    expect(store.scores('ｊａｃｋｅｔ').get('jacket') ?? 0).toBeGreaterThan(0);
  });

  it('tokenizing 2 MB of catalog text stays fast', () => {
    expectLinear((scale) => {
      const text = 'Plain catalog text with no invisible characters. '.repeat(10_000 * scale);
      expect(tokenize(text).length).toBeGreaterThan(0);
    });
  });
});
