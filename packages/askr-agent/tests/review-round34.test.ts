import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts, readCjkNumber } from '../src/price-check';
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

const CURRENCY_OF: Readonly<Record<string, string>> = { ko: 'KRW', zh: 'CNY', ja: 'JPY' };

const usd = (text: string, language: string) => violations('USD', '249', text, language);

describe('1. an approximate amount (多, 余, 来, 几, 여) has no value', () => {
  it.each([
    ['zh', '3万多元'],
    ['zh', '约3万多日元'],
    ['zh', '1700多元'],
    ['zh', '两千多块'],
    ['zh', '两百多块钱'],
    ['zh', '3千多日元'],
    ['ja', '3万多円'],
    ['zh', '3萬多元'],
    ['zh', '3万余元'],
    ['zh', '1700余元'],
    ['zh', '20来块'],
    ['zh', '20几块'],
    ['zh', '十几块'],
    ['ko', '3만여 원'],
  ])('%s "%s" fails in a USD store and in a store at the round number', (language, text) => {
    expect(usd(text, language)).toBe(1);
    expect(violations('CNY', '30000', text, language)).toBe(1);
  });
});

describe('2. more currency words', () => {
  it.each([
    ['ja', '199ユーロ'],
    ['ja', '199ポンド'],
    ['ja', '199ウォン'],
    ['ja', '1700人民元'],
    ['ja', '3万米ドル'],
    ['ja', '約3万ユーロ'],
    ['ko', '300불'],
    ['ko', '300달라'],
    ['ko', '미화 300'],
    ['ko', '300 US달러'],
    ['ko', '300미국달러'],
    ['zh', '300刀'],
    ['zh', '1700泰铢'],
    ['zh', '1700卢布'],
    ['zh', '1700软妹币'],
    ['ja', '3万€'],
    ['en', '3万 bucks'],
    ['ja', '249ドル50セント'],
    ['ko', '249달러 50센트'],
  ])('%s "%s" fails in a USD store at 249', (language, text) => {
    expect(usd(text, language)).toBe(1);
  });

  it('dollar cents read exactly', () => {
    expect(violations('USD', '249.5', '249ドル50セント', 'ja')).toBe(0);
    expect(violations('USD', '249.5', '249달러 50센트', 'ko')).toBe(0);
  });

  it('新元 and 澳门元 are not the yuan', () => {
    expect(violations('CNY', '199', '199新元', 'zh')).toBe(1);
    expect(violations('CNY', '199', '199澳门元', 'zh')).toBe(1);
    expect(violations('SGD', '199', '199新元', 'zh')).toBe(0);
  });

  it('불 and 刀 are money only glued to the number', () => {
    expect(usd('300 불', 'ko')).toBe(0);
    expect(usd('三把刀', 'zh')).toBe(0);
  });
});

describe('3. Korean word exemptions are explicit and narrow', () => {
  it.each([
    '만 원인 제품이에요',
    '천 원인데',
    '만원인 제품',
    '만 엔인 상품이에요',
    '만 원본',
    '만 원형',
    '만원하는 가방',
    '3만 원하시면',
  ])('money "%s" fails in a USD store', (text) => {
    expect(usd(text, 'ko')).toBe(1);
  });

  it.each([
    '블랙만 원하는 분은 말씀해 주세요.',
    '이 색상만 원할 경우 알려 주세요.',
    '이 색상만 원하던 대로 보내 드려요.',
    '이 사이즈만 원치 않으시면 바꿔 드려요.',
    '이 모델만 원터치로 펼쳐집니다.',
    '이 부분만 원활하게 움직입니다.',
    '이 기능만 원격 제어가 됩니다.',
    'V8엔진처럼 힘이 좋아요.',
    '3원색으로 칠했어요.',
  ])('"%s" is no amount (USD and KRW stores)', (text) => {
    expect(usd(text, 'ko')).toBe(0);
    expect(violations('KRW', '37000', text, 'ko')).toBe(0);
  });
});

/** Natural sentences with 块 counting pieces. */
const PIECES = [
  '附赠一块抹布。',
  // 分成两块收纳, 送你一块小毛巾, 由三块组成 are money since round 39 (review-round39).
  '两块砧板一起卖。',
  '三块香皂装在盒子里。',
  '可以切成四块。',
  '一块蓝宝石表镜。',
  '三块拼图组成一幅画。',
  '两块地布。',
  '营地旁边有一块空地。',
  '两块门帘。',
  // '分成两块很方便携带。' is money since round 38 (很 continues a price; review-round38).
  '这款帐篷附带2块垫子。',
];

describe('4. 块 after a small count before a word is a measure word', () => {
  it.each(PIECES)('"%s" has no violation in USD and CNY stores', (text) => {
    expect(usd(text, 'zh')).toBe(0);
    expect(violations('CNY', '249', text, 'zh')).toBe(0);
  });

  it.each([
    '1700块手表',
    '两块看看',
    '五块钱',
    '两块多',
    '三块左右',
    '一块起',
    '50块一个',
    '一块包邮',
  ])('"%s" is money and fails in a USD store', (text) => {
    expect(usd(text, 'zh')).toBe(1);
  });
});

describe('5. 元 and 块 are the yuan of China, Taiwan and Hong Kong', () => {
  it.each(['新台幣 1,290 元', '新台幣1,290元', '1,290塊'])(
    'TWD store at 1290: "%s" passes',
    (text) => {
      expect(violations('TWD', '1290', text, 'zh-TW')).toBe(0);
    },
  );

  it('TWD 2萬4900元 and HKD 249元 pass; a USD store still fails', () => {
    expect(violations('TWD', '24900', '2萬4900元', 'zh-TW')).toBe(0);
    expect(violations('HKD', '249', '249元', 'zh-HK')).toBe(0);
    expect(usd('249元', 'zh')).toBe(1);
  });
});

describe('MINOR', () => {
  it.each([
    ['三块五', '3.5'],
    ['3块5', '3.5'],
    ['3块5毛', '3.5'],
    ['三块五毛钱', '3.5'],
    ['249块5', '249.5'],
    ['249块零5毛', '249.5'],
  ])('CNY: "%s" reads %s, not the whole yuan', (text, value) => {
    expect(violations('CNY', value, text, 'zh')).toBe(0);
    expect(violations('CNY', value.split('.')[0] ?? '0', text, 'zh')).toBe(1);
  });

  it('a bare digit after 元 or before more words is no tenths', () => {
    expect(violations('CNY', '100', '100元5个', 'zh')).toBe(0);
  });

  it.each([
    ['zh', '人民币大约3万'],
    ['zh', '人民币: 约3万'],
    ['ja', '円だと3.7万'],
    ['ja', '円でおよそ3.7万'],
    ['ja', '円換算で3.7万'],
    ['zh', '日元的话3万'],
    ['ko', '원으로 3만'],
  ])('%s: currency first with a longer gap "%s" fails in a USD store', (language, text) => {
    expect(usd(text, language)).toBe(1);
  });

  it('a one-character currency inside a word before a number is no currency', () => {
    expect(usd('単元は3つです。', 'ja')).toBe(0);
  });

  it.each([
    ['ko', '3만에서 4만 원 사이'],
    ['ja', '3万ないし4万円'],
    ['ja', '3万か4万円'],
    ['ja', '3、4万円'],
    ['zh', '3万或4万元'],
    ['zh', '3万或者4万元'],
    ['zh', '3万还是4万元'],
    ['ko', '3만이나 4만 원'],
  ])('%s: the range "%s" checks its lower bound', (language, text) => {
    const currency = CURRENCY_OF[language] ?? 'JPY';
    expect(violations(currency, '40000', text, language)).toBe(1);
  });

  it('a bare lower bound before a magnitude has no value (3、4万円 is 30,000 to 40,000)', () => {
    expect(
      extractAmounts('3、4万円', ['ja', 'en'], 'JPY').map((amount) => amount.values.map(String)),
    ).toEqual([[], ['40000']]);
  });

  it('digits after a Latin letter before エン / 엔 are a model number', () => {
    expect(usd('X3エン モデル', 'ja')).toBe(0);
    expect(usd('X3엔 모델', 'ko')).toBe(0);
    expect(usd('3엔 모델', 'ko')).toBe(1);
  });

  it('一円 after a fee or a price is money', () => {
    expect(usd('税込一円で', 'ja')).toBe(1);
    expect(usd('送料一円で', 'ja')).toBe(1);
    expect(usd('全部で一円で', 'ja')).toBe(1);
    expect(usd('関東一円に配送します。', 'ja')).toBe(0);
  });

  it.each([
    ['zh', '1月1日元旦放假。'],
    ['zh', '2月15日元宵节有活动。'],
    ['zh', '10日元旦前发货。'],
    ['ja', '3日元気に過ごせます。'],
    ['zh', '三元锂电池很耐用。'],
    ['ja', '3元系リチウム電池です。'],
    ['ja', 'V8エンジンの音です。'],
  ])('%s: "%s" is no amount', (language, text) => {
    expect(usd(text, language)).toBe(0);
  });

  it.each([
    ['zh', '三元素'],
    ['ja', '39円8角'],
    ['ja', '三百二百円'],
    ['zh', '两块看看'],
    ['ja', '全部で一円で'],
  ])('%s: "%s" stays flagged', (language, text) => {
    expect(usd(text, language)).toBe(1);
  });

  it('兆 and 조 read 10^12', () => {
    expect(readCjkNumber('1兆')?.toString()).toBe('1000000000000');
    expect(readCjkNumber('1조 2000억')?.toString()).toBe('1200000000000');
    expect(usd('1兆円', 'ja')).toBe(1);
  });

  it('English and European text reads as at 6d00d35 (compared on 68 texts x 14 currencies x 7 locales)', () => {
    expect(
      extractAmounts('Jacket Art. 900 - 1200 €', ['de', 'en'], 'EUR').map((amount) => amount.raw),
    ).toEqual(['1200 €']);
  });
});
