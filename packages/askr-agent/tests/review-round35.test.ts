import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices } from '../src/price-check';
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

const usd = (text: string, language: string) => violations('USD', '249', text, language);

describe('MAJOR-1. 日本円 before a number is yen', () => {
  it.each([
    '日本円で約3.7万',
    '日本円で約37,000',
    '日本円で3万7千',
    '日本円にして37,000',
    '日本円換算で約37,000',
  ])('USD store: "%s" fails', (text) => {
    expect(usd(text, 'ja')).toBe(1);
  });

  it('a JPY store at 37000 accepts 日本円で約3.7万', () => {
    expect(violations('JPY', '37000', '日本円で約3.7万', 'ja')).toBe(0);
  });
});

describe('MAJOR-2. 원 ending a Korean noun is no currency before a number', () => {
  it.each([
    '수용 인원 2명',
    '수용 인원: 2~3명',
    '사용 인원 2인',
    '정원 4명',
    '최대 인원 4인',
    '회원 10% 할인',
    '직원 2명이 상담해 드려요',
    '무상 A/S 지원 1년',
    '보증 기간은 1년, 지원 2회',
    '적정 인원은 2명입니다',
  ])('"%s" has no violation in KRW and USD stores', (text) => {
    expect(violations('KRW', '37000', text, 'ko')).toBe(0);
    expect(usd(text, 'ko')).toBe(0);
  });

  it('a real won amount still reads', () => {
    expect(usd('원 33만', 'ko')).toBe(1);
    expect(usd('33만 원', 'ko')).toBe(1);
    expect(violations('KRW', '330000', '33만 원', 'ko')).toBe(0);
  });

  it.each(['単元3', '次元3', '单元3', '公元2024年'])(
    'a one-character currency inside a word glued to digits: "%s" is no amount',
    (text) => {
      expect(usd(text, 'ja')).toBe(0);
    },
  );
});

describe('MINOR. 块 before a sentence-final particle is money; a split clause takes any count', () => {
  it.each([
    '便宜5块呢',
    '差5块就包邮',
    '便宜5块哦',
    '要5块吗',
    '才8块啊',
    '便宜5块了',
    '只要5块吧',
    '运费5块呀',
  ])('CNY store at 249: "%s" fails', (text) => {
    expect(violations('CNY', '249', text, 'zh')).toBe(1);
  });

  it.each(['拆成12块。', '切成12块', '可拆成12块。', '可以拆12块。'])('"%s" is pieces', (text) => {
    expect(violations('CNY', '249', text, 'zh')).toBe(0);
  });

  it.each(['一盒24块巧克力', '每箱20块瓷砖', '1000块拼图', '十几块地垫'])(
    '"%s" stays money (fail closed)',
    (text) => {
      expect(usd(text, 'zh')).toBe(1);
    },
  );
});

describe('MINOR. guards pinned', () => {
  it('a glued-only token after an approximate amount is money with no value', () => {
    expect(violations('CNY', '249', '300多刀', 'zh')).toBe(1);
    expect(violations('CNY', '249', '大概300多刀', 'zh')).toBe(1);
    expect(violations('USD', '300', '300多刀', 'zh')).toBe(1);
  });

  it('the ternary rule is for small counts only', () => {
    expect(usd('三元锂电池', 'zh')).toBe(0);
    expect(usd('12元锂电池', 'zh')).toBe(1);
  });

  it('日元 after a month and day is a place or a word', () => {
    expect(usd('5月3日元町店でお待ちしています', 'ja')).toBe(0);
  });

  it('엔진 is an engine', () => {
    expect(usd('3엔진', 'ko')).toBe(0);
  });

  it('glued 만원하는 after a space is money', () => {
    expect(usd('가격이 만원하는 가방', 'ko')).toBe(1);
  });

  it('cents only after dollars, tenths only after yuan', () => {
    expect(violations('JPY', '249', '249円50セント', 'ja')).toBe(1);
    expect(violations('JPY', '249', '249円5毛', 'ja')).toBe(1);
    expect(violations('USD', '249.05', '249ドル5セント', 'ja')).toBe(0);
  });

  it('a bare digit glued to a word after 块 is no tenths', () => {
    expect(violations('CNY', '3', '3块5个', 'zh')).toBe(0);
    expect(violations('CNY', '3.5', '3块5个', 'zh')).toBe(1);
  });

  it('불 and 刀 before a number are no currency', () => {
    expect(usd('불 300', 'ko')).toBe(0);
    expect(usd('刀300', 'zh')).toBe(0);
  });

  it('sub-units with a range have no value', () => {
    expect(violations('CNY', '39.8', '38-39元8角', 'zh')).toBe(1);
  });
});

describe('security: a split clause takes a large count only after an explicit split', () => {
  // 分成 with a larger count is money too since round 36 (fail closed).
  it.each(['变成300块。', '变成1700块', '打折后变成300块。', '合计分300块', '分成300块。'])(
    '"%s" is money in USD and CNY stores',
    (text) => {
      expect(usd(text, 'zh')).toBe(1);
      expect(violations('CNY', '249', text, 'zh')).toBe(1);
    },
  );

  it.each(['拆成12块。', '切成12块', '可以拆12块。', '分成两块', '变成两块。'])(
    '"%s" stays pieces',
    (text) => {
      expect(violations('CNY', '249', text, 'zh')).toBe(0);
    },
  );
});
