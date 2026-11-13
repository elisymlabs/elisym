import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { cardsPointer, checkPrices } from '../src/price-check';
import { CONFIG, item } from './fixtures';

/** Violations of `text` in a store of `currency` whose one product, shown as a card, costs `amount`. */
function violations(currency: string, amount: string, text: string, language: string): number {
  const tent = item({ d: 'tent', title: 'Ridge tent', price: { amount, currency } });
  const store = new StoreCatalog({ ...CONFIG, currency, language }, undefined, [tent], []);
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
    locales: [language, 'en'],
  }).length;
}

const cny = (text: string, language = 'zh') => violations('CNY', '249', text, language);

describe('MAJOR-2. a small count before 块 is pieces only right after a stock verb', () => {
  it.each([
    ['zh', '配送费5块。'],
    ['zh', '每单配送费8块。'],
    ['zh', '同城配送5块。'],
    ['zh', '送货费5块。'],
    ['zh', '包装费2块。'],
    ['zh', '装箱费2块。'],
    ['zh', '买一个5块，买两个9块。'],
    ['zh', '买一个5块。'],
    ['zh', '买的话8块。'],
    ['zh', '买两个减5块。'],
    ['zh', '买两件立减5块。'],
    ['zh', '5块就能买到。'],
    ['zh', '9块就可以买一个。'],
    ['zh', '9块就能带走。'],
    ['zh', '这个9块就能用一年。'],
    ['zh', '9块就有了。'],
    ['zh', '用券后5块。'],
    ['zh', '用这个码减5块。'],
    ['zh', '带包装的是8块。'],
    ['zh', '有赠品的那款9块。'],
    ['zh', '送货上门加5块。'],
    ['zh', '够50包邮，不够收6块。'],
    ['zh', '剩下的9块。'],
    ['zh-TW', '買一個9塊。'],
    ['zh-TW', '9塊就能買到。'],
    ['zh-TW', '配送費5塊。'],
    ['zh', '加5块换购收纳袋。'],
  ])('%s: "%s" is money in a CNY store at 249', (language, text) => {
    expect(cny(text, language)).toBe(1);
  });

  // Since round 38 only an explicit split keeps these as pieces (see review-round38).
  it.each(['切成两块就好。', '价格很好，切成两块就好。'])('"%s" stays pieces', (text) => {
    expect(cny(text)).toBe(0);
  });

  it.each(['要的话只剩两块了。', '打折后还剩两块。', '特价只剩两块了。', '这个5块嘛', '这个5塊嗎'])(
    'a price word or no stock verb keeps "%s" money',
    (text) => {
      expect(cny(text)).toBe(1);
    },
  );
});

describe('MAJOR-3. a full-width point between digits is a decimal point, not a sentence end', () => {
  it.each([
    ['JPY', '50000', '約1．5万円です。', 'ja', 1],
    ['JPY', '50000', '約１．５万円です。', 'ja', 1],
    ['CNY', '5', '约1．5元。', 'zh', 1],
    ['CNY', '5', '价格是１．５元。', 'zh', 1],
    ['JPY', '37000', '約３．７万円です。', 'ja', 0],
  ])('%s at %s: "%s"', (currency, amount, text, language, expected) => {
    // Read whole: 15000 yen and 1.5 yuan are not these store prices, 37000 yen is.
    expect(violations(currency, amount, text, language)).toBe(expected);
  });

  it('...and the exact price passes', () => {
    expect(violations('JPY', '15000', '約1．5万円です。', 'ja')).toBe(0);
    expect(violations('CNY', '1.5', '价格是１．５元。', 'zh')).toBe(0);
    expect(violations('JPY', '37000', '約３．７万円です。', 'ja')).toBe(0);
  });

  it('a full-width point after a word still ends a sentence', () => {
    expect(violations('CNY', '249', '这款很轻．切成两块就好。', 'zh')).toBe(0);
  });
});

describe('MINOR', () => {
  it('pointer locales with an underscore', () => {
    expect(cardsPointer('zh_TW')).toBe('價格請見商品卡片。');
    expect(cardsPointer('zh-HK')).toBe('價格請見商品卡片。');
    expect(cardsPointer('ja_JP')).toBe('価格はカードをご覧ください。');
  });

  it('RMB and NTD read in any case, before or after the number', () => {
    for (const text of ['RMB 1800', '1800 rmb', 'NTD 7,800', '7,800 ntd', 'ntd7800']) {
      expect(violations('USD', '249', text, 'en'), text).toBe(1);
    }
    expect(violations('TWD', '7800', '7,800 ntd', 'zh-TW')).toBe(0);
    expect(violations('CNY', '1800', 'RMB 1800', 'zh')).toBe(0);
  });

  it('a spaced Australian dollar is AUD', () => {
    expect(violations('USD', '199', '199호주 달러', 'ko')).toBe(1);
    expect(violations('AUD', '199', '199호주 달러', 'ko')).toBe(0);
  });

  it.each(['一盒六块。', '每盒三块。', '一包两块。'])(
    'documented fail-closed: "%s" (price per box or pieces) is money',
    (text) => {
      expect(cny(text)).toBe(1);
    },
  );
});
