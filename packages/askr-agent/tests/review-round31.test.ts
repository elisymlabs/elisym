import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts, readCjkNumber } from '../src/price-check';
import { CONFIG, expectLinear, item } from './fixtures';

const ADDRESS_OF = (author: string, productId: string) => `30402:${author}:${productId}`;

function storeOf(currency: string, language: string, amount: string) {
  const tent = item({ d: 'tent', title: 'Ridge tent', price: { amount, currency } });
  return {
    tent,
    store: new StoreCatalog({ ...CONFIG, currency, language }, undefined, [tent], []),
  };
}

function violations(currency: string, language: string, amount: string, text: string): number {
  const { tent, store } = storeOf(currency, language, amount);
  const answer: Answer = {
    type: 'answer',
    ask_id: '0'.repeat(32),
    session_end: 1,
    text,
    components: [{ type: 'products', picks: [{ address: ADDRESS_OF(tent.author, 'tent') }] }],
    chips: [],
  };
  return checkPrices(answer, {
    storeCurrency: currency,
    items: store.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, 'en'],
  }).length;
}

function readings(text: string, locale: string) {
  return extractAmounts(text, [locale, 'en'], 'USD').map((amount) => ({
    values: amount.values.map(String),
    currencies: amount.currencies,
  }));
}

describe('B1. a converted price written with CJK magnitudes fails the check (fail closed)', () => {
  it.each([
    ['ja', 'リッジテントは249ドルで、約3.7万円です。'],
    ['ja', '約3万7千円です。'],
    ['ja', '3.7万円'],
    ['ja', '3万7千円'],
    ['ja', '37,000円'],
    ['ja', '¥37,000'],
    ['ja', '¥3.7万'],
    ['ja', '3.7萬円'],
    ['ja', '円で3.7万'],
    ['ja', '約三万七千円'],
    ['zh', '3700元'],
    ['zh', '约3.7万元'],
    ['zh', '约2.6万人民币'],
    ['ko', '3만 7천원'],
    ['ko', '약 3.7만원'],
    ['ko', '3,7만원'],
  ])('USD store, %s: "%s" is a violation', (_language, text) => {
    expect(violations('USD', 'en', '249', text)).toBe(1);
  });

  it('the dollar price itself, written in Japanese, passes; another dollar figure does not', () => {
    expect(violations('USD', 'en', '249', 'リッジテントは249ドルです。')).toBe(0);
    expect(violations('USD', 'en', '249', 'リッジテントは199ドルです。')).toBe(1);
  });
});

describe('B2. exact evidence passes in a store of that currency', () => {
  it.each([
    ['JPY', 'ja', '3.7万円'],
    ['JPY', 'ja', '3万7千円'],
    ['JPY', 'ja', '三万七千円'],
    ['JPY', 'ja', '37,000円'],
    ['JPY', 'ja', '¥3.7万'],
    ['CNY', 'zh', '3.7万元'],
    ['KRW', 'ko', '3만 7천원'],
    ['KRW', 'ko', '3.7만원'],
  ])('%s store at 37000: "%s" passes', (currency, language, text) => {
    expect(violations(currency, language, '37000', `${text}です。`)).toBe(0);
  });

  it.each([
    ['JPY', 'ja', '3.8万円'],
    ['JPY', 'ja', '3万8千円'],
    ['KRW', 'ko', '3만 8천원'],
    // A comma next to a magnitude is ambiguous: no value, so it matches nothing.
    ['KRW', 'ko', '3,7만원'],
  ])('%s store at 37000: "%s" fails', (currency, language, text) => {
    expect(violations(currency, language, '37000', text)).toBe(1);
  });
});

describe('B3. reading CJK numbers', () => {
  it.each([
    ['3.7万', '37000'],
    ['3万7千', '37000'],
    ['三万七千', '37000'],
    ['1億2千万', '120000000'],
    ['二十', '20'],
    ['十五', '15'],
    ['千', '1000'],
    ['3만 7천', '37000'],
    ['2億', '200000000'],
    // A thousands comma reads since review round 33.
    ['1,000万', '10000000'],
  ])('"%s" reads %s', (expression, value) => {
    expect(readCjkNumber(expression)?.toString()).toBe(value);
  });

  it.each(['万万', '3万2億', '3,7万', '三3万'])('"%s" does not read', (expression) => {
    expect(readCjkNumber(expression)).toBeUndefined();
  });

  it('a range gives two amounts, each checked', () => {
    expect(readings('3万〜4万円', 'ja')).toEqual([
      { values: ['30000'], currencies: ['JPY'] },
      { values: ['40000'], currencies: ['JPY'] },
    ]);
  });

  it('numbers without a currency are not amounts', () => {
    expect(readings('1万歩あるきました。元気で三人です。', 'ja')).toEqual([]);
    expect(readings('3万7千人が使っています', 'ja')).toEqual([]);
  });

  it('stays linear on long CJK text', () => {
    expectLinear((scale) => {
      extractAmounts('三万七千円と3.7万円、'.repeat(200 * scale), ['ja', 'en'], 'USD');
    });
  });
});
