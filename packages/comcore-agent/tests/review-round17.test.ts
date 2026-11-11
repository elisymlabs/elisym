import type { Answer } from '@elisym/comcore';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { stripInvisible } from '../src/fence';
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

describe('A1. a suffix token of the previous sentence lends nothing', () => {
  it.each([
    ['INR', 'en', 'Jacket: 1200 Rs. Boots: 1200 Rs.'],
    ['INR', 'en', 'The Jacket is 1200 Rs. The Boots are also 1200 Rs.'],
    ['INR', 'en', 'The Jacket is 1200 Rs. The Boots are also ₹1200.'],
    ['CHF', 'de', 'Die Jacket kostet 1200 Fr. Die Boots kosten 1200 Fr.'],
    ['RUB', 'ru', 'Jacket стоит 1200 руб. Boots тоже 1200 руб.'],
    ['RUB', 'ru', 'Boots стоит 999 руб. Jacket тоже 999 руб.'],
  ])('%s %s: "%s" is caught', (currency, language, text) => {
    expect(twoProducts(currency, language, text)).toBe(1);
  });

  it('a symbol that really starts the amount still borrows its sentence', () => {
    expect(twoProducts('INR', 'en', 'The Jacket costs Rs. 1200.')).toBe(0);
  });
});

describe('A2-A3. every invisible character class is stripped, everywhere in the text', () => {
  it('C0 and C1 controls go, tab and newline stay', () => {
    expect(stripInvisible('9\u0000\u0085\u007f200\tA\nB')).toBe('9200\tA\nB');
  });

  it('several separate invisibles all go', () => {
    expect(stripInvisible('9­2​00')).toBe('9200');
  });
});

describe('B. coverage', () => {
  it.each([
    ['EUR', 'en', 'That is 1150 pounds sterling.'],
    ['EUR', 'de', 'Das sind 1150 Pfund Sterling.'],
    ['EUR', 'fr', 'Soit 1150 livres sterling.'],
    ['EUR', 'es', 'Son 1150 libras esterlinas.'],
    ['EUR', 'nl', 'Dat is 1150 Britse pond.'],
    ['EUR', 'en', 'About 1150 Japanese yen.'],
    ['EUR', 'en', 'About 1150 Chinese yuan.'],
    ['EUR', 'ru', 'Около 1150 японских иен.'],
  ])('%s %s: a converted price "%s" is caught', (currency, language, text) => {
    expect(violationsIn(currency, language, text)).toBe(1);
  });

  it.each(['La veste coûte 1150 FCFA.', 'La veste coûte 1150 CFA.'])(
    'XOF store: "%s" is read',
    (text) => {
      expect(extractAmounts(text, ['fr'], 'XOF')[0]?.currencies).toContain('XOF');
    },
  );
});
