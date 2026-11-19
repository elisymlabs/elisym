import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, readCjkNumber } from '../src/price-check';
import { CONFIG, item } from './fixtures';

/** Violations of `text` in a store of `currency` whose one product, shown as a card, costs `amount`. */
function violations(currency: string, amount: string, text: string): number {
  const tent = item({ d: 'tent', title: 'Ridge tent', price: { amount, currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language: 'ja' }, undefined, [tent], []);
  const answer: Answer = {
    type: 'answer',
    ask_id: '0'.repeat(32),
    session_end: 1,
    text,
    components: [{ type: 'products', picks: [{ address: `30402:${tent.author}:tent` }] }],
    chips: [],
  };
  return checkPrices(answer, {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: ['ja', 'en'],
  }).length;
}

describe('S1. a currency on both sides of a CJK number must agree', () => {
  it('disagreeing tokens match no currency: the amount fails', () => {
    expect(violations('JPY', '30000', '¥3万ドルです。')).toBe(1);
    expect(violations('USD', '30000', '¥3万ドルです。')).toBe(1);
  });

  it('plain digits are left to the token scanners only when every token is theirs', () => {
    expect(violations('JPY', '37000', '¥37000ドルです。')).toBe(1);
    expect(violations('JPY', '37000', '¥37000円です。')).toBe(0);
  });

  it('agreeing tokens keep their currency', () => {
    expect(violations('JPY', '37000', '円で3.7万円です。')).toBe(0);
  });
});

describe('S2. an explicit zero or an abbreviated tail does not read', () => {
  it.each(['0万', '〇万', '零万', '0千', '三万五', '一千二', '3万5', '3万500', '2千5'])(
    '"%s" has no value',
    (expression) => {
      expect(readCjkNumber(expression)).toBeUndefined();
    },
  );

  it.each([
    ['万', '10000'],
    ['千', '1000'],
    ['3万7000', '37000'],
    ['1億2000万', '120000000'],
    ['十五', '15'],
    ['二十五', '25'],
  ])('"%s" reads %s', (expression, value) => {
    expect(readCjkNumber(expression)?.toString()).toBe(value);
  });

  it.each([
    ['10000', '0万円'],
    ['30005', '三万五円'],
    ['1002', '一千二円'],
  ])('a store at %s does not accept "%s"', (amount, text) => {
    expect(violations('JPY', amount, `${text}です。`)).toBe(1);
  });

  it('the full forms still pass', () => {
    expect(violations('JPY', '35000', '三万五千円です。')).toBe(0);
    expect(violations('JPY', '37000', '3万7000円です。')).toBe(0);
  });
});

describe('S3. a token reading that overlaps a CJK number is not dropped wholesale', () => {
  it('a dollar reading starting before the CJK number must pass on its own', () => {
    expect(violations('JPY', '50000', 'US$5万円です。')).toBe(1);
  });

  it('only the same number cut short is replaced', () => {
    expect(violations('JPY', '37000', '¥3.7万です。')).toBe(0);
    expect(violations('JPY', '37000', '¥3.8万です。')).toBe(1);
  });
});
