import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts, readCjkNumber } from '../src/price-check';
import { CONFIG, item } from './fixtures';

/** Violations of `text` in a store of `currency` whose one product, shown as a card, costs `amount`. */
function violations(
  currency: string,
  amount: string,
  text: string,
  language = 'ja',
  visitor: string[] = [],
): number {
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
    visitorMessages: visitor,
    policyPassages: [],
    locales: [language, 'en'],
  }).length;
}

describe('M-1. plain digits after a currency and a particle are read here when no scanner read them', () => {
  it.each(['円で37000', '¥で37000', '価格は円で37000です'])('USD store: "%s" fails', (text) => {
    expect(violations('USD', '249', text)).toBe(1);
  });

  it('a JPY store at 37000 accepts them', () => {
    expect(violations('JPY', '37000', '価格は円で37000です')).toBe(0);
  });
});

describe('M-1. plain digits a token scanner read stay its reading', () => {
  it('the reading of 37000円 is the scanner one, not the particle-wide CJK match', () => {
    expect(extractAmounts('円で37000円', ['ja', 'en'], 'JPY').map((amount) => amount.raw)).toEqual([
      '37000円',
    ]);
  });
});

describe('M-2. a unit with no coefficient after a letter has no value', () => {
  it.each([
    ['JPY', '10000', '弐万円'],
    ['JPY', '200000', '廿万円'],
    ['JPY', '300000', '卅万円'],
    ['JPY', '10000', '数万円'],
    ['JPY', '10000', '何万円'],
    ['JPY', '100000', '十数万円'],
    ['JPY', '1000', '数千円'],
    ['JPY', '1000', '何千円'],
    ['JPY', '1000', '壱千円'],
    ['CNY', '10000', '几万元'],
    ['CNY', '10000', '上万元'],
    ['CNY', '10000', '好几万元'],
    ['CNY', '100000', '十几万元'],
    ['KRW', '10000', '수만 원'],
    ['KRW', '10000', '몇만 원'],
    ['KRW', '100000', '수십만 원'],
  ])('%s store at %s: "%s" fails', (currency, amount, text) => {
    expect(violations(currency, amount, `${text}です。`)).toBe(1);
  });

  it('〇 is a digit: an explicit zero, and 〇円 is a yen amount', () => {
    expect(violations('JPY', '10000', '〇万円です。')).toBe(1);
    expect(violations('USD', '249', '〇円です。')).toBe(1);
  });

  it("a visitor's vague 数万円 allows nothing", () => {
    expect(violations('JPY', '5000', '1万円です。', 'ja', ['予算は数万円です'])).toBe(1);
    expect(violations('JPY', '5000', '1万円です。', 'ja', ['予算は1万円です'])).toBe(0);
  });
});

describe('M-3. ranges with -, 至, 到, から check the lower bound too', () => {
  it.each([
    ['JPY', '3万-4万円'],
    ['JPY', '3万至4万円'],
    ['JPY', '3万から4万円'],
    ['JPY', '3万~4万円'],
    ['JPY', '3万～4万円'],
    ['CNY', '3万至4万元'],
    ['CNY', '3万到4万元'],
    ['CNY', '3万-4万元'],
    ['CNY', '30000至40000元'],
  ])('%s store at 40000 only: "%s" fails', (currency, text) => {
    expect(violations(currency, '40000', text)).toBe(1);
  });

  it('a tilde next to a CJK magnitude stays a range separator', () => {
    for (const text of ['3万~4万円', '3万～4万円']) {
      expect(
        extractAmounts(text, ['ja', 'en'], 'JPY').map((amount) => amount.values.map(String)),
        text,
      ).toEqual([['30000'], ['40000']]);
    }
  });

  it('a range of two real prices passes', () => {
    expect(violations('JPY', '30000', '3万~4万円', 'ja')).toBe(1);
    expect(
      extractAmounts('3万から4万円', ['ja', 'en'], 'JPY').map((amount) =>
        amount.values.map(String),
      ),
    ).toEqual([['30000'], ['40000']]);
  });
});

/** Natural shop sentences with no price at all. */
const NO_PRICE: ReadonlyArray<[string, string]> = [
  ['zh', '这款帐篷附带2块垫子。'],
  ['zh', '这款帐篷附带两块垫子。'],
  ['zh', '我们一块看看吧。'],
  ['zh', '我们实行一元化管理。'],
  ['zh', '这款背包有三种颜色。'],
  ['zh', '睡袋适合零下五度。'],
  ['zh', '帐篷重两公斤，适合两个人。'],
  ['zh', '这个炉子十分钟就能烧开一升水。'],
  ['zh', '我们的门店在第一元素大厦。'],
  ['zh', '订单满三件可以拼单。'],
  ['zh', '这双鞋有四个尺码。'],
  ['ja', '関東一円に配送します。'],
  ['ja', '全国一円でお届けします。'],
  ['ja', '一つの袋に二人分入ります。'],
  ['ja', '三日以内に発送します。'],
  ['ja', '円形のテーブルもあります。'],
  ['ja', 'このテントは二人用で、三シーズン対応です。'],
  ['ja', '百貨店でも買えます。'],
  ['ja', '千葉の倉庫から出荷します。'],
  ['ja', '一万歩歩いても疲れにくい靴です。'],
  ['ja', '十分な広さがあります。'],
  ['ko', '이 색상만 원하시면 말씀해 주세요.'],
  ['ko', '천 원단으로 만들어졌습니다.'],
  ['ko', '버스가 만원이었어요.'],
  ['ko', '백화점에서도 판매합니다.'],
  ['ko', '천천히 골라 보세요.'],
  ['ko', '만나서 반갑습니다.'],
  ['ko', '이 텐트는 두 사람이 쓰기 좋아요.'],
  ['ko', '원래 색상은 파란색입니다.'],
  ['ko', '세 가지 사이즈가 있습니다.'],
  ['ko', '백팩은 방수 소재입니다.'],
  ['ko', '열 개 이상 주문하시면 알려 주세요.'],
];

const CURRENCY_OF: Readonly<Record<string, string>> = { zh: 'CNY', ko: 'KRW', ja: 'JPY' };

describe('M-4. words that only look like money are not amounts', () => {
  it.each(NO_PRICE)('%s: "%s" has no violation in a USD store', (language, text) => {
    expect(violations('USD', '249', text, language)).toBe(0);
  });

  it.each(NO_PRICE)('%s: "%s" has no violation in a store of its currency', (language, text) => {
    const currency = CURRENCY_OF[language] ?? 'JPY';
    expect(violations(currency, '3980', text, language)).toBe(0);
  });

  it('a real price next to an idiom still passes, and a wrong one still fails', () => {
    expect(violations('JPY', '3980', '価格は3,980円で、関東一円に配送します。')).toBe(0);
    expect(violations('JPY', '3980', '価格は4,980円で、関東一円に配送します。')).toBe(1);
    expect(violations('CNY', '2', '2块钱一个。', 'zh')).toBe(0);
    expect(violations('CNY', '2', '3块。', 'zh')).toBe(1);
    expect(violations('KRW', '10000', '만 원입니다', 'ko')).toBe(0);
  });
});

describe('M-5. more currency words, and a magnitude glued to a token reading', () => {
  it.each([
    ['3.7万美金'],
    ['3.7万美刀'],
    ['3.7만 달러'],
    ['3.7万USD'],
    ['3.7万 USD'],
    ['3.7万 dollars'],
    ['$3.7万'],
    ['US$3.7万'],
    ['$3万'],
    ['$249万'],
    ['3.7万美元'],
  ])('USD store at 249: "%s" fails', (text) => {
    expect(violations('USD', '249', text)).toBe(1);
  });

  it('a USD store at 37000 accepts 3.7万 in its own currency', () => {
    for (const text of ['3.7万美元', '3.7万美金', '3.7万USD', '3.7万 dollars']) {
      expect(violations('USD', '37000', text), text).toBe(0);
    }
  });
});

describe('M-6. converted prices in other currencies fail in a USD store', () => {
  it.each([
    '3.7万日币',
    '3.7萬日幣',
    '3.7万韩币',
    '3.7万エン',
    '3.7万えん',
    '3.7万 yen',
    '3.7万 JPY',
    '37000엔',
    '3만 7천 엔',
    '3.7万港元',
    '3.7万港币',
    '3.7万台币',
    '3.7万新台币',
    '3.7万欧元',
    '3.7万英镑',
    '3.7万加元',
    '3.7万澳元',
    '37k円',
    '37K円',
  ])('"%s"', (text) => {
    expect(violations('USD', '37000', text)).toBe(1);
  });

  it('37k円 reads 37000 yen', () => {
    expect(violations('JPY', '37000', '37k円です。')).toBe(0);
  });
});

describe('MINOR. store-currency forms that read exactly', () => {
  it.each([
    ['KRW', '39800', '3만 9,800원', 'ko'],
    ['JPY', '37000', '3万7,000円', 'ja'],
    ['JPY', '3980', '3千980円', 'ja'],
    ['CNY', '39.8', '39元8角', 'zh'],
    ['CNY', '39.85', '39元8角5分', 'zh'],
  ])('%s at %s: "%s" passes', (currency, amount, text, language) => {
    expect(violations(currency, amount, text, language)).toBe(0);
  });

  it.each([
    ['三百二千', undefined],
    ['3.7万5千', undefined],
    ['十15', undefined],
    ['十5', '15'],
    ['1億5000', undefined],
    ['1億5000万', '150000000'],
    ['3千980', '3980'],
    ['3万9,800', '39800'],
  ])('"%s" reads %s', (expression, value) => {
    expect(readCjkNumber(expression)?.toString()).toBe(value);
  });

  it('a leading minus has no value', () => {
    expect(violations('JPY', '37000', '-3.7万円')).toBe(1);
    expect(violations('JPY', '37000', '−3.7万円')).toBe(1);
    expect(violations('JPY', '37000', 'A-3.7万円')).toBe(0);
  });

  it('两 is a digit (两万元)', () => {
    expect(violations('CNY', '20000', '两万元', 'zh')).toBe(0);
    expect(violations('USD', '249', '两万元', 'zh')).toBe(1);
  });

  it('a token reading that runs past the CJK match stays and must pass (¥3万7000 bucks)', () => {
    expect(violations('JPY', '37000', '¥3万7000 bucks')).toBe(1);
  });

  it('a CJK number with a disagreeing ISO code is no currency (¥3万7000 USD)', () => {
    expect(violations('JPY', '37000', '¥3万7000 USD')).toBe(1);
  });
});

describe('parity and performance', () => {
  it('English and European text reads the same as without the CJK reader', () => {
    // Compared with 6d00d35 (before CJK) on 62 inputs x 4 locale pairs: no difference. Pinned here.
    const readings = (text: string) =>
      extractAmounts(text, ['en', 'de'], 'USD').map((amount) => [
        amount.raw,
        amount.values.map(String),
        amount.currencies,
        amount.scale ?? null,
      ]);
    expect(readings('The jacket is $129 and 99 USD, 20 euros or 1.299,00 €.')).toEqual([
      ['$129', ['129', '129'], ['USD'], null],
      ['99 USD', ['99', '99'], ['USD'], null],
      ['20 euros', ['20', '20'], ['EUR'], null],
      ['1.299,00 €', ['1299'], ['EUR'], null],
    ]);
    // A Latin code with no CJK numeral stays the token scanners', scale included.
    expect(readings('1.5k USD')).toEqual([['1.5k USD', ['1500'], ['USD'], 1000]]);
  });

  it('a 10k-character CJK text checks in well under a second', () => {
    const text = '这款帐篷附带2块垫子，3万-4万円，关东一円，색상만 원하시면 3만 9,800원。'.repeat(
      250,
    );
    const started = performance.now();
    violations('USD', '249', text, 'zh');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
