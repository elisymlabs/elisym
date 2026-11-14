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
describe('MAJOR-1. only listed qualifiers and ISO codes qualify', () => {
  it.each([
    '1ハンドル混合水栓です。価格は4980円です。',
    '2ハンドル混合栓は4980円です。',
    'LED 3キャンドルセットは4980円です。',
    'ミシン用 3ニードルは4980円です。',
    '2 ヌードルは4980円です。',
    '2アイドルは4980円です。',
    '2ハードルは4980円です。',
    '2 バンドルは4980円です。',
    '2 LED 円形ライトは4980円です。',
  ])('JPY 4980: "%s" passes', (text) => {
    expect(failures('JPY', '4980', text, 'ja')).toBe(0);
  });

  it.each([
    '모델마다 무게가 약 200그램 달라요.',
    '길이가 5센티 달라요.',
    '사이즈가 2단계 달라요.',
    '색상이 3가지 달라요.',
    '높이가 10센티미터 달라요.',
    '100미터 달라요.',
    '2인용 달라요.',
    '2XL 원피스도 있어요.',
    '3XL 원피스예요.',
    '2XL 원하시면 말씀하세요.',
    '사이즈는 2XL 원형 넥이에요.',
    '2XL 원단이에요.',
    '64GB 원래 모델이에요.',
    '용량은 256GB 원래 330,000원이었어요.',
    '2TB 원격 백업이에요.',
    '2 LED 원형 조명이에요.',
    '2 PVC 원단이에요.',
  ])('KRW 330000: "%s" passes', (text) => {
    expect(failures('KRW', '330000', text, 'ko')).toBe(0);
  });

  it.each(['5 LED 元件，售价299元。', '含2 PCB 元件，299元。'])('CNY 299: "%s" passes', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(0);
  });

  it('an unknown Latin word before ドル is no qualifier (backlog: no reading at all)', () => {
    expect(currenciesOf('約100 MXドルです。', 'ja', 'USD')).toEqual([]);
  });

  it.each([
    ['約100メキシコドルです。', 'ja', 'MXN'],
    ['約100ブラジルドルです。', 'ja', 'BRL'],
    ['약 100 러시아 달러예요.', 'ko', 'RUB'],
    ['约100印度元。', 'zh', 'INR'],
    ['约100印尼元。', 'zh', 'IDR'],
    ['約100タイドルです。', 'ja', 'THB'],
    ['約100フィリピンドルです。', 'ja', 'PHP'],
    ['약 100 베트남 달러예요.', 'ko', 'VND'],
    ['約100マレーシアドルです。', 'ja', 'MYR'],
    ['约100南非元。', 'zh', 'ZAR'],
    ['约100阿根廷元。', 'zh', 'ARS'],
    ['約100トルコドルです。', 'ja', 'TRY'],
  ])(
    'a listed country names its currency: "%s" is %s, failing in USD',
    (text, language, currency) => {
      expect(currenciesOf(text, language, 'USD')).toEqual([[currency]]);
      expect(failures('USD', '100', text, language)).toBe(1);
    },
  );

  it('an ISO code qualifies: 249 CADドル passes in CAD 249 and fails in USD 249', () => {
    expect(failures('CAD', '249', '249 CADドルです。', 'ja')).toBe(0);
    expect(failures('USD', '249', '249 CADドルです。', 'ja')).toBe(1);
  });
});

describe('MAJOR-2. a qualifier never makes a word into a price', () => {
  it.each([
    '这款3米圆顶帐篷售价299元。',
    '直径1.2米圆桌，299元。',
    '1.5米圆床，299元。',
    '这是1米圆形地垫。',
    '10米圆管，299元。',
    '直径2米圓形，299元。',
    '3米元素，299元。',
    '5中国元素，299元。',
  ])('CNY 299: "%s" passes', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(0);
  });

  it('a one-character qualifier still names ドル and a katakana unit', () => {
    expect(currenciesOf('100米ドルです。', 'ja', 'JPY')).toEqual([['USD']]);
    expect(currenciesOf('80英ポンドです。', 'ja', 'JPY')).toEqual([['GBP']]);
  });
});

describe('MAJOR-3. converted prices with listed qualifiers still fail', () => {
  it.each([
    ['JPY', '15000', '約100USドルです。', 'ja'],
    ['JPY', '15000', '約100アメリカドルです。', 'ja'],
    ['JPY', '15000', '約13万韓国ウォン。', 'ja'],
    ['JPY', '15000', '約80英ポンドです。', 'ja'],
    ['JPY', '15000', '約770中国元です。', 'ja'],
    ['JPY', '15000', '約100カナダ・ドル。', 'ja'],
    ['KRW', '15000', '약 11 미국 달러예요.', 'ko'],
    ['KRW', '15000', '미국 달러로 약 11이에요.', 'ko'],
    ['KRW', '15000', '약 1,600 일본 엔이에요.', 'ko'],
    ['CNY', '1699', '约合2万韩国元。', 'zh'],
    ['CNY', '1699', '100新西兰元。', 'zh'],
    ['CNY', '1699', '235美国元。', 'zh'],
  ])('%s %s: "%s" fails', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(1);
  });

  const forms: Array<[string, string]> = [];
  const formOf = (word: string): [string, string] | undefined => {
    if (/^\p{Script=Hangul}/u.test(word)) {
      return [`약 12,000 ${word} 달러예요.`, 'ko'];
    }
    if (/^\p{Script=Katakana}/u.test(word) || /^[A-Z]/u.test(word)) {
      return [`約1万2000${word}ドルです。`, 'ja'];
    }
    // A one-character Han qualifier names ドル only.
    return word.length === 1
      ? [`約1万2000${word}ドルです。`, 'ja']
      : [`约合1万2000${word}元。`, 'zh'];
  };
  for (const word of [
    'NZ',
    'ニュージーランド',
    '新西兰',
    '뉴질랜드',
    'AU',
    'オーストラリア',
    '豪',
    '澳大利亚',
    '호주',
    'HK',
    '香港',
    'ホンコン',
    '홍콩',
    'SG',
    'シンガポール',
    '新加坡',
    '싱가포르',
    'CA',
    'カナダ',
    '加拿大',
    '캐나다',
    'NT',
    '台湾',
    '台灣',
    '대만',
    '韓国',
    '韩国',
    '한국',
    '日本',
    '일본',
    '中国',
    '중국',
    '英',
    'イギリス',
    '영국',
    'スイス',
    '瑞士',
    '스위스',
    'メキシコ',
    'ブラジル',
    'ロシア',
    'インド',
    'タイ',
    'ベトナム',
    'CAD',
    'EUR',
    'GBP',
  ]) {
    const form = formOf(word);
    if (form !== undefined) {
      forms.push(form);
    }
  }

  it.each(forms)('USD 249: converted "%s" fails', (text, language) => {
    expect(failures('USD', '249', text, language)).toBe(1);
  });

  it.each([
    ['約249USドルです。', 'ja'],
    ['約249アメリカドルです。', 'ja'],
    ['約249米ドルです。', 'ja'],
    ['약 249 미국 달러예요.', 'ko'],
    ['249美国元。', 'zh'],
  ])('USD 249: "%s" passes', (text, language) => {
    expect(failures('USD', '249', text, language)).toBe(0);
  });
});

describe('MINOR-1. a qualifier before a sign names nothing', () => {
  it.each(['- お米 ¥4,980です。', '米 ¥4,980です。', 'もち米 ¥4,980です。'])(
    'JPY 4980: "%s" passes',
    (text) => {
      expect(failures('JPY', '4980', text, 'ja')).toBe(0);
    },
  );

  it.each(['- 米 ¥299。', '英 ¥4980。', '豪 ¥299。', '美国 ¥299。'])(
    'CNY: "%s" reads the sign alone',
    (text) => {
      const amount = text.includes('4980') ? '4980' : '299';
      expect(failures('CNY', amount, text, 'zh')).toBe(0);
    },
  );
});

describe('MINOR-2. a name that starts like a currency word', () => {
  it.each([
    ['2フランス製のバッグです。', 'ja'],
    ['3 フランスパンです。', 'ja'],
    ['2ルーブル美術館の展示です。', 'ja'],
    ['2 프랑스 브랜드예요.', 'ko'],
    ['100 프랑스산이에요.', 'ko'],
    ['5 바트맨 피규어예요.', 'ko'],
    ['5弗吉尼亚。', 'zh'],
    ['2弗兰克。', 'zh'],
  ])('"%s" is no price', (text, language) => {
    expect(currenciesOf(text, language, 'JPY')).toEqual([]);
  });

  it('the currency word alone is still money', () => {
    expect(failures('JPY', '4980', '100フランです。', 'ja')).toBe(1);
    expect(failures('KRW', '330000', '100 프랑이에요.', 'ko')).toBe(1);
  });
});

describe('MINOR-3. more currency words fail closed', () => {
  it.each([
    ['ko', '100루블이에요.', ['RUB']],
    ['ko', '100루피예요.', ['INR', 'PKR', 'LKR', 'NPR']],
    ['zh', '100比索。', ['MXN', 'PHP', 'ARS', 'CLP', 'COP']],
    ['ja', '100ペソです。', ['MXN', 'PHP', 'ARS', 'CLP', 'COP']],
    ['ko', '100페소예요.', ['MXN', 'PHP', 'ARS', 'CLP', 'COP']],
    ['zh', '100越南盾。', ['VND']],
    ['zh', '100雷亚尔。', ['BRL']],
    ['zh', '100克朗。', ['SEK', 'NOK', 'DKK', 'CZK', 'ISK']],
    ['zh', '100兹罗提。', ['PLN']],
    ['zh', '100里拉。', ['TRY']],
    ['zh', '100兰特。', ['ZAR']],
    ['ja', '100ルピアです。', ['IDR']],
    ['ja', '100ディルハムです。', ['AED', 'MAD']],
  ])('%s "%s" is %j and fails in a JPY store', (language, text, currencies) => {
    expect(currenciesOf(text, language, 'JPY')).toEqual([currencies]);
    expect(failures('JPY', '100', text, language)).toBe(1);
  });

  it('5克朗姆酒 and 3里拉链 are no price', () => {
    expect(currenciesOf('5克朗姆酒。', 'zh', 'CNY')).toEqual([]);
    expect(currenciesOf('3里拉链。', 'zh', 'CNY')).toEqual([]);
  });
});

describe('MINOR-4. the currency-first side', () => {
  it.each([
    ['CNY', '20000', '韩国元20000。', 'zh'],
    ['TWD', '100', '美国元100。', 'zh'],
    ['CNY', '20000', '韩国元 2万。', 'zh'],
    ['KRW', '100', '약 100 스위스 프랑이에요.', 'ko'],
  ])('%s %s: "%s" fails', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(1);
  });

  it('the store the qualifier names passes', () => {
    expect(failures('KRW', '20000', '韩国元20000。', 'zh')).toBe(0);
    expect(failures('CHF', '100', '약 100 스위스 프랑이에요.', 'ko')).toBe(0);
  });
});
// cspell:enable
