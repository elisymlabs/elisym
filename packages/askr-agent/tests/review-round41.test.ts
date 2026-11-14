import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import {
  PIECE_NOUN_STARTS,
  checkPrices,
  extractAmounts,
  stripViolations,
} from '../src/price-check';
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
const cny = (text: string, amount = '8') => failures('CNY', amount, text, 'zh');

function currenciesOf(text: string, language: string, store: string): string[][] {
  return extractAmounts(text, [language, 'en'], store).map((amount) => amount.currencies);
}

// cspell:disable
describe('MAJOR-1. a country between the number and the currency word names the currency', () => {
  it.each([
    ['約100USドルです。', 'USD'],
    ['約100 US ドルです。', 'USD'],
    ['約100ＵＳドルです。', 'USD'],
    ['約100 U.S. ドルです。', 'USD'],
    ['約100アメリカドルです。', 'USD'],
    ['約13万韓国ウォン。', 'KRW'],
    ['約80英ポンドです。', 'GBP'],
    ['約770中国元です。', 'CNY'],
    ['約100シンガポールドル。', 'SGD'],
    ['約100ニュージーランドドル。', 'NZD'],
    ['約100オーストラリアドル。', 'AUD'],
    ['約100カナダ・ドル。', 'CAD'],
    ['約100スイスフラン。', 'CHF'],
  ])('ja "%s" is %s and fails in a JPY store at 15000', (text, currency) => {
    expect(currenciesOf(text, 'ja', 'JPY')).toEqual([[currency]]);
    expect(failures('JPY', '15000', text, 'ja')).toBe(1);
  });

  it.each([
    ['약 11 미국 달러예요.', 'USD'],
    ['약 11미국 달러예요.', 'USD'],
    ['약 100 US 달러예요.', 'USD'],
    ['약 100 U.S. 달러예요.', 'USD'],
    ['미국 달러로 약 11이에요.', 'USD'],
    ['약 1,600 일본 엔이에요.', 'JPY'],
    ['약 80 중국 위안이에요.', 'CNY'],
    ['약 10 싱가포르 달러예요.', 'SGD'],
  ])('ko "%s" is %s and fails in a KRW store at 15000', (text, currency) => {
    expect(currenciesOf(text, 'ko', 'KRW')).toEqual([[currency]]);
    expect(failures('KRW', '15000', text, 'ko')).toBe(1);
  });

  it.each([
    ['约合2万韩国元。', 'KRW'],
    ['100新西兰元。', 'NZD'],
    ['235美国元。', 'USD'],
    ['约合1699台湾元。', 'TWD'],
  ])('zh "%s" is %s and fails in a CNY store at 1699', (text, currency) => {
    expect(currenciesOf(text, 'zh', 'CNY')).toEqual([[currency]]);
    expect(failures('CNY', '1699', text, 'zh')).toBe(1);
  });

  it.each([
    ['USD', '11', '약 11 미국 달러예요.', 'ko'],
    ['USD', '11', '미국 달러로 약 11이에요.', 'ko'],
    ['USD', '100', '約100アメリカドルです。', 'ja'],
    ['CAD', '100', '約100カナダ・ドル。', 'ja'],
    ['KRW', '20000', '约合2万韩国元。', 'zh'],
    ['NZD', '100', '100新西兰元。', 'zh'],
    ['JPY', '1600', '약 1,600 일본 엔이에요.', 'ko'],
    ['KRW', '130000', '約13万韓国ウォン。', 'ja'],
  ])('the store the qualifier names passes: %s %s "%s"', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(0);
  });

  it.each([
    ['CAD', '100', '約100アメリカドルです。', 'ja'],
    ['USD', '100', '約100カナダ・ドル。', 'ja'],
    ['CAD', '11', '약 11 미국 달러예요.', 'ko'],
    ['CNY', '20000', '约合2万韩国元。', 'zh'],
    ['TWD', '100', '100新西兰元。', 'zh'],
    ['HKD', '235', '235美国元。', 'zh'],
  ])(
    'a qualified form never reads as another store currency: %s %s "%s"',
    (currency, amount, text, language) => {
      expect(failures(currency, amount, text, language)).toBe(1);
    },
  );

  it.each([['約100中国円です。', 'ja', 'JPY']])(
    'a qualifier the unit does not fit matches nothing: "%s"',
    (text, language, store) => {
      expect(currenciesOf(text, language, store)).toEqual([[]]);
      expect(failures(store, '100', text, language)).toBe(1);
    },
  );

  it.each([
    ['約100メキシコドルです。', 'ja'],
    ['약 100 멕시코 달러예요.', 'ko'],
  ])('a listed country names its own currency (round 42): "%s"', (text, language) => {
    expect(currenciesOf(text, language, 'USD')).toEqual([['MXN']]);
    expect(failures('USD', '100', text, language)).toBe(1);
  });

  it('a qualifier inside a word before the currency is no qualifier', () => {
    expect(currenciesOf('15,000日本円です。', 'ja', 'JPY')).toEqual([['JPY']]);
    expect(currenciesOf('100米ドルです。', 'ja', 'JPY')).toEqual([['USD']]);
  });
});

describe('MINOR-1. more currency words', () => {
  it.each([
    ['ja', '100フランです。', ['CHF']],
    ['ja', '100ルーブルです。', ['RUB']],
    ['ja', '100バーツです。', ['THB']],
    ['ja', '100ルピーです。', ['INR', 'PKR', 'LKR', 'NPR']],
    ['ja', '100弗です。', ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD']],
    ['ko', '100프랑이에요.', ['CHF']],
    ['ko', '100바트예요.', ['THB']],
    ['ko', '100인민폐예요.', ['CNY']],
    ['zh', '100法郎。', ['CHF']],
    ['zh', '100瑞士法郎。', ['CHF']],
    ['zh', '100卢比。', ['INR', 'PKR', 'LKR', 'NPR']],
    ['zh', '100林吉特。', ['MYR']],
    ['zh', '100马币。', ['MYR']],
    ['zh', '100新加坡币。', ['SGD']],
    ['zh', '100美圆。', ['USD']],
  ])('%s "%s" is %j', (language, text, currencies) => {
    expect(currenciesOf(text, language, 'JPY')).toEqual([currencies]);
  });

  it('ja 米$ is USD', () => {
    expect(currenciesOf('米$100です。', 'ja', 'JPY')).toEqual([['USD']]);
  });

  it('they fail in a store of another currency', () => {
    expect(failures('JPY', '100', '100バーツです。', 'ja')).toBe(1);
    expect(failures('CNY', '100', '100林吉特。', 'zh')).toBe(1);
    expect(failures('KRW', '100', '100인민폐예요.', 'ko')).toBe(1);
  });
});

describe('MINOR-2. the piece noun list is pinned', () => {
  it('lists exactly these nouns', () => {
    expect([...PIECE_NOUN_STARTS]).toEqual([
      '砧板',
      '香皂',
      '肥皂',
      '抹布',
      '毛巾',
      '地垫',
      '地墊',
      '防潮垫',
      '防潮墊',
      '防潮布',
      '面板',
      '垫',
      '墊',
      '地布',
      '门帘',
      '門簾',
      '拼图',
      '拼圖',
      '电池',
      '電池',
      '太阳能',
      '太陽能',
      '板子',
      '木板',
      '石头',
      '石頭',
      '玻璃',
      '表镜',
      '錶鏡',
      '滤芯',
      '濾芯',
      '滤网',
      '濾網',
      '挡板',
      '擋板',
      '内胆',
      '內膽',
      '护垫',
      '護墊',
      '牛排',
      '能量棒',
      '巧克力',
      '蛋糕',
      '元宵',
      '瓷砖',
      '瓷磚',
      '地毯',
      '磁铁',
      '磁鐵',
      '海绵',
      '海綿',
      '镜片',
      '鏡片',
      '蓝宝石',
      '藍寶石',
      '空地',
      '布',
      '面料',
      '布料',
      '皮革',
      '真皮',
      '可替换',
      '可替換',
      '可更换',
      '可更換',
      '可拆卸',
      '可水洗',
      '便携',
      '便攜',
      '备用',
      '備用',
      '替换',
      '替換',
      '更换用',
      '更換用',
      '防水',
      '防滑',
      '硅胶',
      '矽膠',
      '不锈钢',
      '不鏽鋼',
      '实木',
      '實木',
      '纯棉',
      '純棉',
    ]);
  });

  it('垫子 and 墊子 still count pieces through 垫 / 墊', () => {
    expect(cny('两块垫子。')).toBe(0);
    expect(cny('两块墊子。')).toBe(0);
  });
});

describe('MINOR-3. splits and dates', () => {
  it('切成两块了 is a split, not a price', () => {
    expect(cny('切成两块了。')).toBe(0);
  });

  it('a digit after 块 in a split clause is money', () => {
    expect(cny('切成3块5。')).toBe(1);
  });

  it.each(['15日元宵節です。', '正月十五日元宵节放假。'])('"%s" is a date, no price', (text) => {
    expect(failures('JPY', '15000', text, 'ja')).toBe(0);
    expect(cny(text)).toBe(0);
  });
});

describe('MINOR-4. a word of price before the count makes it money', () => {
  it.each([
    '加9块替换成铝合金杆。',
    '再加5块防水升级。',
    '加5块防水升级。',
    '只要9块防水喷雾。',
    '只需3块备用电池。',
    '仅2块替换装。',
    '才5块防滑垫。',
  ])('"%s" is money in a CNY store at 8', (text) => {
    expect(cny(text)).toBe(1);
  });

  it('一块 as "together" after 才 stays no price', () => {
    expect(cny('我们才一块去。')).toBe(0);
  });

  it('without the word the noun still counts pieces', () => {
    expect(cny('附赠两块防水垫。')).toBe(0);
  });
});

describe('MINOR-5. more words that start like 元宵', () => {
  it.each(['9块元宵佳节特价。', '9块元宵佳節特價。', '9块元宵期间特价。', '9块元宵期間特價。'])(
    '"%s" is money',
    (text) => {
      expect(cny(text)).toBe(1);
    },
  );
});

describe('NIT. a stripped sentence leaves no double space', () => {
  it('the space after a stripped sentence goes with it', () => {
    const { answer, found } = check('USD', '249', 'Great tent. It costs $199. Ships free.', 'en');
    expect(found).toHaveLength(1);
    expect(stripViolations(answer, found, 'en').text).toBe(
      'Great tent. Ships free. See the cards for prices.',
    );
  });

  it('a newline after a stripped sentence stays', () => {
    const { answer, found } = check('USD', '249', 'Great tent.\nIt costs $199.\nShips free.', 'en');
    expect(found).toHaveLength(1);
    expect(stripViolations(answer, found, 'en').text).not.toContain('  ');
  });
});
// cspell:enable
