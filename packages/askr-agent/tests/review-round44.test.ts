import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { CONFIG, item } from './fixtures';

function check(currency: string, amount: string, text: string, language: string) {
  const tent = item({ d: 'tent', title: 'Ridge tent', price: { amount, currency } });
  const catalog = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [tent], []);
  const answer: Answer = {
    type: 'answer',
    ask_id: '0'.repeat(32),
    session_end: 1,
    text,
    components: [{ type: 'products', picks: [{ address: `30402:${tent.author}:tent` }] }],
    chips: [],
  };
  const found = checkPrices(answer, {
    storeCurrency: currency,
    items: catalog.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, 'en'],
  });
  return { answer, found };
}

const failures = (currency: string, amount: string, text: string, language: string) =>
  check(currency, amount, text, language).found.length;

function currenciesOf(text: string, language: string, store: string): string[][] {
  return extractAmounts(text, [language, 'en'], store).map((amount) => amount.currencies);
}

// cspell:disable
describe('MINOR-1. 원 in a noun after a qualifier', () => {
  it.each([
    'TOP 3 한국 원두를 소개해요.',
    '1+1 한국 원두예요.',
    '2026 한국 원두 페스티벌이에요.',
    'ISO 9001 한국 원료 사용해요.',
    '모델 X200 한국 원산지 제품이에요.',
    '330,000원이에요. 3 한국 원료만 사용해요.',
    '2 미국 원목 의자예요.',
    'Type 3 미국 원목이에요.',
    '2 미국 원작 영화예요.',
    '2 한국 원룸이에요.',
    '2 한국 원래 모델이에요.',
    '2 한국 원칙이에요.',
  ])('KRW 330000: "%s" passes', (text) => {
    expect(failures('KRW', '330000', text, 'ko')).toBe(0);
  });

  it('a verb form stays money: 약 30만 한국원할인', () => {
    expect(failures('KRW', '330000', '약 30만 한국원할인이에요.', 'ko')).toBe(1);
  });
});

describe('MINOR-2. 圆领 after a qualifier is a word; other forms fail closed', () => {
  it.each(['3 美国圆领T恤，299元。', '3美國圓領T恤，299元。'])('CNY 299: "%s" passes', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(0);
  });

  // Accepted false positives: a currency word that starts a longer word. Fail closed.
  it.each([
    ['JPY', '4980', '2アメリカドルフィンです。', 'ja'],
    ['JPY', '4980', '2米ドルチェです。', 'ja'],
    ['JPY', '4980', '2英ポンドケーキです。', 'ja'],
    ['CNY', '299', 'X200美国元件。', 'zh'],
  ])('accepted false positive: %s %s "%s" fails closed', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(1);
  });
});

describe('MINOR-3. a whole currency word wins over the word lists', () => {
  it.each([
    ['SGD', '约199新加坡元素。'],
    ['CAD', '约199加拿大元素。'],
    ['AUD', '约199澳大利亚元素。'],
  ])('%s 249: "%s" fails', (currency, text) => {
    expect(failures(currency, '249', text, 'zh')).toBe(1);
  });
});

describe('MINOR-4. the Han word lists', () => {
  it.each(['199美国圆桌，299元。', '约199美國圓形，299元。'])(
    'a 圆 word after a multi-character qualifier: "%s" passes in CNY 299',
    (text) => {
      expect(failures('CNY', '299', text, 'zh')).toBe(0);
    },
  );

  it('the 圆 words do not apply to 元: 199美国元形 is money', () => {
    expect(failures('CNY', '299', '199美国元形。', 'zh')).toBe(1);
  });

  it.each([
    '約2000ルーブルで、美しいデザインです。',
    '約2000ルーブル、美品です。',
    '約2000ルーブル美品です。',
  ])('ルーブル is a name only before 美術: "%s" fails in JPY 4980', (text) => {
    expect(failures('JPY', '4980', text, 'ja')).toBe(1);
  });

  it('2ルーブル美術館 is no price', () => {
    expect(currenciesOf('2ルーブル美術館の展示です。', 'ja', 'JPY')).toEqual([]);
  });
});

describe('MINOR-5. a year before 元旦 / 元宵 / 元年 / 元宇宙', () => {
  it.each([
    '2026元旦活动。',
    '2026年元旦。',
    '2026元旦促销。',
    '2026元宵节。',

    '2026元宇宙。',
  ])('CNY 299: "%s" is no price', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(0);
  });

  it.each(['2026元。', '2026元的帐篷。', '售价3000元旦日发货。'])('"%s" is still money', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(1);
  });
});
// cspell:enable
