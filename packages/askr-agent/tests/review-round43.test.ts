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
const WHOLE_WORDS: Array<[string, string]> = [
  ['米ドル', 'USD'],
  ['カナダドル', 'CAD'],
  ['香港ドル', 'HKD'],
  ['豪ドル', 'AUD'],
  ['台湾ドル', 'TWD'],
  ['スイスフラン', 'CHF'],
  ['USドル', 'USD'],
  ['アメリカドル', 'USD'],
  ['英ポンド', 'GBP'],
];
const SUFFIXES = ['オフ', 'セール', 'モデル', 'プラン', 'クーポン'];
const MATRIX: Array<[string, string]> = WHOLE_WORDS.flatMap(([word, currency]) =>
  SUFFIXES.map((suffix): [string, string] => [`199${word}${suffix}です。`, currency]),
);

describe('MAJOR-1. a whole katakana currency word before more katakana is money', () => {
  it.each([
    ['USD', '20米ドルオフです。'],
    ['USD', '20米ドルクーポンです。'],
    ['USD', '199米ドルモデルです。'],
    ['USD', '199米ドルプランです。'],
    ['USD', '10米ドルギフトカード付きです。'],
    ['USD', '送料10米ドルプラスです。'],
    ['USD', '10 USドルオフです。'],
    ['USD', '199アメリカドルモデルです。'],
    ['CHF', '199スイスフランモデルです。'],
    ['GBP', '20英ポンドオフです。'],
    ['EUR', '199 EURユーロセールです。'],
  ])('%s 249: "%s" fails', (currency, text) => {
    expect(failures(currency, '249', text, 'ja')).toBe(1);
  });

  it.each(['約30米ドルセールです。', '約100カナダドルセールです。', '約30 GBPポンドセールです。'])(
    'JPY 4980: "%s" fails',
    (text) => {
      expect(failures('JPY', '4980', text, 'ja')).toBe(1);
    },
  );

  it.each(MATRIX)('"%s" fails at 249 in %s', (text, currency) => {
    expect(failures(currency, '249', text, 'ja')).toBe(1);
  });

  it.each(MATRIX)('"%s" passes at 199 in %s', (text, currency) => {
    expect(failures(currency, '199', text, 'ja')).toBe(0);
  });
});

describe('MAJOR-2. a whole Chinese currency word before more Han is money', () => {
  it.each([
    ['SGD', '满200新加坡元领取赠品。'],
    ['SGD', '满200新加坡元领券。'],
    ['CAD', '满200加拿大元领取赠品。'],
    ['CAD', '200加拿大元件套装。'],
    ['CAD', '200加拿大元点数。'],
    ['CAD', '200加拿大元周边。'],
    ['AUD', '满200澳大利亚元领取赠品。'],
    ['AUD', '200澳大利亚元件套装。'],
    ['AUD', '200澳大利亚元点数。'],
    ['AUD', '200澳大利亚元周边。'],
  ])('%s 249: "%s" fails', (currency, text) => {
    expect(failures(currency, '249', text, 'zh')).toBe(1);
  });

  it('the right price passes', () => {
    expect(failures('SGD', '200', '满200新加坡元领取赠品。', 'zh')).toBe(0);
  });
});

describe('MINOR-1. only 元素 and the 圆 words are words after a qualifier', () => {
  it.each([
    '199美国元件。',
    '约100美国元点。',
    '199香港元件套装。',
    '约100澳洲元点。',
    '约100美国元周边。',
  ])('CNY 299: "%s" fails closed', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(1);
  });

  it.each(['5中国元素，299元。', '直径1.2米圆桌，299元。', '这款3米圆顶帐篷售价299元。'])(
    'CNY 299: "%s" passes',
    (text) => {
      expect(failures('CNY', '299', text, 'zh')).toBe(0);
    },
  );
});

describe('MINOR-3. フランク is a name, フランクーポン is not', () => {
  it('199スイスフランクーポン is CHF', () => {
    expect(failures('CHF', '199', '199スイスフランクーポンです。', 'ja')).toBe(0);
    expect(failures('USD', '199', '199スイスフランクーポンです。', 'ja')).toBe(1);
  });

  it('2フランクフルト is no price', () => {
    expect(currenciesOf('2フランクフルトです。', 'ja', 'JPY')).toEqual([]);
  });
});

describe('MINOR-4. glued words after a qualified unit', () => {
  it('약 30만 한국원할인 is read', () => {
    expect(failures('KRW', '330000', '약 30만 한국원할인이에요.', 'ko')).toBe(1);
  });

  it('约300弗拉 is read', () => {
    expect(failures('CNY', '299', '约300弗拉。', 'zh')).toBe(1);
  });
});

describe('MINOR-5. the guards that stay', () => {
  it.each(['直径6米圆，299元。', '2英圆，299元。', '长3米美元区也能买。'])(
    'a one-character Han qualifier before a Han unit is a word: "%s" passes in CNY 299',
    (text) => {
      expect(failures('CNY', '299', text, 'zh')).toBe(0);
    },
  );

  it('the currency-first side: 米円4980 reads no amount', () => {
    expect(currenciesOf('米円4980です。', 'ja', 'JPY')).toEqual([]);
  });

  it.each([
    '미국 사이즈 10 US 원피스예요.',
    '10 US 원형 테이블이에요.',
    '약 2 한국 원형 테이블이에요.',
  ])('원 in a word after a qualifier: "%s" passes in KRW 330000', (text) => {
    expect(failures('KRW', '330000', text, 'ko')).toBe(0);
  });

  it('an ISO code qualifies only as a whole Latin word', () => {
    expect(failures('CAD', '249', '249 CADドルです。', 'ja')).toBe(0);
    expect(currenciesOf('100 CADXドルです。', 'ja', 'USD')).toEqual([]);
  });
});
// cspell:enable
