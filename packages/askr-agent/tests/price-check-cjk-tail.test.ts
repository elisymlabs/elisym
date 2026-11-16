import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, extractAmounts } from '../src/price-check';
import { CONFIG, expectLinear, item } from './fixtures';

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
  return checkPrices(answer, {
    storeCurrency: currency,
    items: catalog.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, 'en'],
  });
}

const failures = (currency: string, amount: string, text: string, language: string) =>
  check(currency, amount, text, language).length;

function currenciesOf(text: string, language: string, store: string): string[][] {
  return extractAmounts(text, [language, 'en'], store).map((amount) => amount.currencies);
}

function valuesOf(text: string, language: string, store: string): string[][] {
  return extractAmounts(text, [language, 'en'], store).map((amount) =>
    amount.values.map((value) => value.toString()),
  );
}

// cspell:disable
describe('a country prefix before a dollar word names its country', () => {
  it.each([
    ['約100 MXドルです。', 'ja', 'MXN'],
    ['約100MXドルです。', 'ja', 'MXN'],
    ['约100 MX元。', 'zh', 'MXN'],
    ['약 100 MX 달러예요.', 'ko', 'MXN'],
    ['約100 TWドルです。', 'ja', 'TWD'],
    ['約100ニュー台湾ドルです。', 'ja', 'TWD'],
    ['約100タイワンドルです。', 'ja', 'TWD'],
    ['약 100 타이완 달러예요.', 'ko', 'TWD'],
    ['约100新台湾元。', 'zh', 'TWD'],
    ['約100米国ドルです。', 'ja', 'USD'],
    ['約100合衆国ドルです。', 'ja', 'USD'],
    ['約100アメリカ合衆国ドルです。', 'ja', 'USD'],
    ['약 100 미 달러예요.', 'ko', 'USD'],
    ['약 100미달러예요.', 'ko', 'USD'],
    ['約100豪州ドルです。', 'ja', 'AUD'],
    ['約100加ドルです。', 'ja', 'CAD'],
    ['約100ジャマイカドルです。', 'ja', 'JMD'],
    ['约100牙买加元。', 'zh', 'JMD'],
    ['약 100 자메이카 달러예요.', 'ko', 'JMD'],
    ['約100 JMドルです。', 'ja', 'JMD'],
    ['約100フィジードルです。', 'ja', 'FJD'],
    ['约100斐济元。', 'zh', 'FJD'],
    ['約100ブルネイドルです。', 'ja', 'BND'],
    ['约100文莱元。', 'zh', 'BND'],
    ['약 100 브루나이 달러예요.', 'ko', 'BND'],
    ['約100バハマドルです。', 'ja', 'BSD'],
    ['約100バルバドスドルです。', 'ja', 'BBD'],
    ['約100ベリーズドルです。', 'ja', 'BZD'],
    ['約100バミューダドルです。', 'ja', 'BMD'],
    ['約100ケイマンドルです。', 'ja', 'KYD'],
    ['約100ガイアナドルです。', 'ja', 'GYD'],
    ['約100リベリアドルです。', 'ja', 'LRD'],
    ['約100ナミビアドルです。', 'ja', 'NAD'],
    ['約100スリナムドルです。', 'ja', 'SRD'],
    ['約100ソロモンドルです。', 'ja', 'SBD'],
    ['約100トリニダード・トバゴドルです。', 'ja', 'TTD'],
    ['约100特立尼达和多巴哥元。', 'zh', 'TTD'],
    ['約100東カリブドルです。', 'ja', 'XCD'],
    ['约100东加勒比元。', 'zh', 'XCD'],
    ['약 100 동카리브 달러예요.', 'ko', 'XCD'],
    ['約100ジンバブエドルです。', 'ja', 'ZWG'],
    ['约100澳门元。', 'zh', 'MOP'],
    ['約100マカオドルです。', 'ja', 'MOP'],
    ['MXドル100です。', 'ja', 'MXN'],
    ['미 달러로 약 100이에요.', 'ko', 'USD'],
  ])('"%s" (%s) is %s and fails in a JPY store at 100', (text, language, currency) => {
    expect(currenciesOf(text, language, 'JPY')).toEqual([[currency]]);
    expect(failures('JPY', '100', text, language)).toBe(1);
  });

  it.each([
    ['USD', '約100米国ドルです。', 'ja'],
    ['USD', '약 100 미 달러예요.', 'ko'],
    ['AUD', '約100豪州ドルです。', 'ja'],
    ['CAD', '約100加ドルです。', 'ja'],
    ['TWD', '約100ニュー台湾ドルです。', 'ja'],
    ['TWD', '约100新台湾元。', 'zh'],
    ['MXN', '約100 MXドルです。', 'ja'],
    ['JMD', '约100牙买加元。', 'zh'],
    ['XCD', '約100東カリブドルです。', 'ja'],
  ])('the store the prefix names passes: %s "%s"', (currency, text, language) => {
    expect(failures(currency, '100', text, language)).toBe(0);
  });

  it.each([
    ['USD', '約100 MXドルです。', 'ja'],
    ['USD', '約100ジャマイカドルです。', 'ja'],
    ['CNY', '约100牙买加元。', 'zh'],
    ['KRW', '약 100 자메이카 달러예요.', 'ko'],
    ['USD', '約100ニュー台湾ドルです。', 'ja'],
    ['USD', '約100加ドルです。', 'ja'],
  ])(
    'a prefixed dollar never reads as another dollar store: %s "%s"',
    (currency, text, language) => {
      expect(failures(currency, '100', text, language)).toBe(1);
    },
  );

  it.each([
    ['ja', '約100 XYドルです。'],
    ['ko', '길이가 5CM 달라요.'],
    ['ko', '용량 64GB 달라요.'],
    ['ko', '색상 2 EU 사이즈 달라요.'],
    ['ko', '2 EU 원산지예요.'],
    ['ko', '2 UK 사이즈예요.'],
    ['ko', '색이 조금 미 달라요.'],
    ['ja', '2チリソースです。'],
    ['ja', '3タイワンリス。'],
  ])('%s "%s" is no amount', (language, text) => {
    expect(currenciesOf(text, language, 'KRW')).toEqual([]);
  });
});

describe('a country prefix before the dollar sign names its country', () => {
  it.each([
    ['HK$1,200です。', 'ja', 'HKD'],
    ['约HK$1,200。', 'zh', 'HKD'],
    ['NZ$1,200です。', 'ja', 'NZD'],
    ['售价NT$1,200。', 'zh', 'TWD'],
    ['MX$1,200です。', 'ja', 'MXN'],
    ['S$1,200예요.', 'ko', 'SGD'],
    ['SG$1,200예요.', 'ko', 'SGD'],
    ['AU$1,200です。', 'ja', 'AUD'],
    ['CA$1,200です。', 'ja', 'CAD'],
    ['J$1,200です。', 'ja', 'JMD'],
    ['TT$1,200です。', 'ja', 'TTD'],
    ['EC$1,200です。', 'ja', 'XCD'],
    ['The Jacket is HK$1,200.', 'en', 'HKD'],
  ])('"%s" (%s) is %s and fails in a USD store at 1200', (text, language, currency) => {
    expect(currenciesOf(text, language, 'USD')).toEqual([[currency]]);
    expect(failures('USD', '1200', text, language)).toBe(1);
  });

  it.each([
    ['HKD', 'HK$1,200です。', 'ja'],
    ['TWD', '售价NT$1,200。', 'zh'],
    ['TWD', '售价$1,200。', 'zh'],
    ['SGD', 'S$1,200예요.', 'ko'],
    ['NZD', 'NZ$1,200です。', 'ja'],
    ['MXN', 'MX$1,200です。', 'ja'],
    ['USD', 'US$1,200です。', 'ja'],
    ['USD', '$1,200です。', 'ja'],
    ['AUD', 'A$1,200です。', 'ja'],
    ['AUD', 'AU$1,200です。', 'ja'],
    ['CAD', 'C$1,200です。', 'ja'],
  ])('the store the prefix names passes: %s "%s"', (currency, text, language) => {
    expect(failures(currency, '1200', text, language)).toBe(0);
  });
});

describe('spelled-out and variant currency words', () => {
  it.each([
    ['約100ユウロです。', 'ja', ['EUR']],
    ['約100ユ-ロです。', 'ja', ['EUR']],
    ['約100ユ–ロです。', 'ja', ['EUR']],
    ['約100ユ－ロです。', 'ja', ['EUR']],
    ['約100ﾕｰﾛです。', 'ja', ['EUR']],
    ['約100ヨーロッパユーロです。', 'ja', ['EUR']],
    ['約100 EUユーロです。', 'ja', ['EUR']],
    ['約100欧州ユーロです。', 'ja', ['EUR']],
    ['約100英パウンドです。', 'ja', ['GBP']],
    ['約100ﾎﾟﾝﾄﾞです。', 'ja', ['GBP']],
    ['約100UKポンドです。', 'ja', ['GBP']],
    ['約100スターリングポンドです。', 'ja', ['GBP']],
    ['約13万ウオンです。', 'ja', ['KRW']],
    ['約2000ルーブリです。', 'ja', ['RUB']],
    ['約100ダラーです。', 'ja', ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD']],
    ['約100ジャマイカダラーです。', 'ja', ['JMD']],
    ['約700ユアンです。', 'ja', ['CNY']],
    ['約100レアルです。', 'ja', ['BRL']],
    ['約100ブラジルレアルです。', 'ja', ['BRL']],
    ['約100リンギットです。', 'ja', ['MYR']],
    ['約100ズロチです。', 'ja', ['PLN']],
    ['約100ズウォティです。', 'ja', ['PLN']],
    ['約100ポーランドズロチです。', 'ja', ['PLN']],
    ['約100スウェーデンクローナです。', 'ja', ['SEK']],
    ['約100ノルウェークローネです。', 'ja', ['NOK']],
    ['約100デンマーククローネです。', 'ja', ['DKK']],
    ['約100チェココルナです。', 'ja', ['CZK']],
    ['約100ハンガリーフォリントです。', 'ja', ['HUF']],
    ['約100シェケルです。', 'ja', ['ILS']],
    ['約100テンゲです。', 'ja', ['KZT']],
    ['約100フリヴニャです。', 'ja', ['UAH']],
    ['約100クウェートディナールです。', 'ja', ['KWD']],
    ['約100サウジ・リヤルです。', 'ja', ['SAR']],
    ['約100サウジリアルです。', 'ja', ['SAR']],
    ['約100UAEディルハムです。', 'ja', ['AED']],
    ['約100南アフリカランドです。', 'ja', ['ZAR']],
    ['約100南アランドです。', 'ja', ['ZAR']],
    ['約100トルコリラです。', 'ja', ['TRY']],
    ['約50万ベトナムドンです。', 'ja', ['VND']],
    ['約100ペルーソルです。', 'ja', ['PEN']],
    ['약 100딸라예요.', 'ko', ['USD']],
    ['약 100 유로화예요.', 'ko', ['EUR']],
    ['약 1,600엔화예요.', 'ko', ['JPY']],
    ['엔화로 약 1,600이에요.', 'ko', ['JPY']],
    ['달러화로 약 100이에요.', 'ko', ['USD']],
    ['약 100 미국 달러화예요.', 'ko', ['USD']],
    ['약 100 헤알이에요.', 'ko', ['BRL']],
    ['약 100 브라질 레알이에요.', 'ko', ['BRL']],
    ['약 100 링깃이에요.', 'ko', ['MYR']],
    ['약 100 즐로티예요.', 'ko', ['PLN']],
    ['약 100 스웨덴 크로나예요.', 'ko', ['SEK']],
    ['약 100 체코 코루나예요.', 'ko', ['CZK']],
    ['약 100 포린트예요.', 'ko', ['HUF']],
    ['약 100 셰켈이에요.', 'ko', ['ILS']],
    ['약 100 루피아예요.', 'ko', ['IDR']],
    ['약 100 남아공 랜드예요.', 'ko', ['ZAR']],
    ['약 100 터키 리라예요.', 'ko', ['TRY']],
    ['약 50만 베트남 동이에요.', 'ko', ['VND']],
    ['약 100 사우디 리얄이에요.', 'ko', ['SAR']],
    ['약 100 UK 파운드예요.', 'ko', ['GBP']],
    ['约100日圆。', 'zh', ['JPY']],
    ['约100纽币。', 'zh', ['NZD']],
    ['约100紐元。', 'zh', ['NZD']],
    ['约100欧罗。', 'zh', ['EUR']],
    ['约100歐羅。', 'zh', ['EUR']],
    ['约100英磅。', 'zh', ['GBP']],
    ['约100镑。', 'zh', ['GBP']],
    ['约100鎊。', 'zh', ['GBP']],
    ['约100印尼盾。', 'zh', ['IDR']],
    ['约100令吉。', 'zh', ['MYR']],
    ['约100瑞郎。', 'zh', ['CHF']],
    ['约100澳门币。', 'zh', ['MOP']],
    ['约100韩圆。', 'zh', ['KRW']],
    ['约100韓圜。', 'zh', ['KRW']],
    ['约100披索。', 'zh', ['MXN', 'PHP', 'ARS', 'CLP', 'COP']],
    ['约100坡币。', 'zh', ['SGD']],
    ['约100谢克尔。', 'zh', ['ILS']],
    ['约100迪拉姆。', 'zh', ['AED', 'MAD']],
    ['约100沙特里亚尔。', 'zh', ['SAR']],
    ['约100列伊。', 'zh', ['RON']],
    ['约100列弗。', 'zh', ['BGN']],
    ['约100坚戈。', 'zh', ['KZT']],
    ['约100格里夫纳。', 'zh', ['UAH']],
    ['约100匈牙利福林。', 'zh', ['HUF']],
    ['约100秘鲁索尔。', 'zh', ['PEN']],
    ['约100蚊。', 'zh', ['HKD']],
    ['镑100。', 'zh', ['GBP']],
  ])('"%s" (%s) is %j', (text, language, currencies) => {
    expect(currenciesOf(text, language, 'JPY')).toEqual([currencies]);
  });

  it.each([
    ['JPY', '100', '約100ユウロです。', 'ja'],
    ['JPY', '100', '約100ユ-ロです。', 'ja'],
    ['JPY', '100', '約100UKパウンドです。', 'ja'],
    ['JPY', '130000', '約13万ウオンです。', 'ja'],
    ['JPY', '2000', '約2000ルーブリです。', 'ja'],
    ['JPY', '100', '約100ダラーです。', 'ja'],
    ['JPY', '700', '約700ユアンです。', 'ja'],
    ['KRW', '1600', '엔화로 약 1,600이에요.', 'ko'],
    ['KRW', '100', '약 100딸라예요.', 'ko'],
    ['CNY', '100', '约100日圆。', 'zh'],
    ['CNY', '100', '约100英磅。', 'zh'],
    ['CNY', '100', '约100蚊。', 'zh'],
    ['USD', '100', '约100纽币。', 'zh'],
  ])('%s %s: converted "%s" fails', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(1);
  });

  it.each([
    ['EUR', '100', '約100ユウロです。', 'ja'],
    ['EUR', '100', '約100ユ-ロです。', 'ja'],
    ['EUR', '100', '約100ヨーロッパユーロです。', 'ja'],
    ['GBP', '100', '約100パウンドです。', 'ja'],
    ['GBP', '100', '約100UKポンドです。', 'ja'],
    ['KRW', '130000', '約13万ウオンです。', 'ja'],
    ['RUB', '2000', '約2000ルーブリです。', 'ja'],
    ['USD', '100', '約100ダラーです。', 'ja'],
    ['CNY', '700', '約700ユアンです。', 'ja'],
    ['BRL', '100', '約100レアルです。', 'ja'],
    ['SEK', '100', '約100スウェーデンクローナです。', 'ja'],
    ['ZAR', '100', '約100ランドです。', 'ja'],
    ['TRY', '100', '約100リラです。', 'ja'],
    ['VND', '500000', '約50万ドンです。', 'ja'],
    ['JPY', '1600', '엔화로 약 1,600이에요.', 'ko'],
    ['USD', '100', '약 100딸라예요.', 'ko'],
    ['KRW', '330000', '원화로 330,000원이에요.', 'ko'],
    ['KRW', '330000', '약 330,000원화예요.', 'ko'],
    ['VND', '500000', '약 50만 동이에요.', 'ko'],
    ['JPY', '100', '约100日圆。', 'zh'],
    ['GBP', '100', '约100英磅。', 'zh'],
    ['HKD', '100', '约100蚊。', 'zh'],
    ['NZD', '100', '约100纽币。', 'zh'],
    ['HUF', '3', '3福林。', 'zh'],
  ])('the store currency passes: %s %s "%s"', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(0);
  });

  it('a value is read exactly: 約13万ウオン is 130000', () => {
    expect(valuesOf('約13万ウオンです。', 'ja', 'KRW')).toEqual([['130000']]);
  });
});

describe('words that only look like the new currency words are no price', () => {
  it.each([
    ['JPY', '4980', '3ランドセルは4980円です。', 'ja'],
    ['JPY', '4980', '3 ランドリーバッグは4980円です。', 'ja'],
    ['JPY', '4980', '2リラックスチェアは4980円です。', 'ja'],
    ['JPY', '4980', '3ドンキで買えます。4980円です。', 'ja'],
    ['JPY', '4980', '4Kリアルタイム映像で4980円です。', 'ja'],
    ['JPY', '4980', '3リアルレザーで4980円です。', 'ja'],
    ['JPY', '4980', '2パウンドケーキは4980円です。', 'ja'],
    ['JPY', '4980', '3ルーブリックは4980円です。', 'ja'],
    ['JPY', '4980', '2レアルマドリードのユニフォームは4980円です。', 'ja'],
    ['JPY', '4980', '3コルナゴのバイクは4980円です。', 'ja'],
    ['JPY', '4980', '2ソルトは4980円です。', 'ja'],
    ['CNY', '299', '5月3日圆满结束，299元。', 'zh'],
    ['CNY', '299', '3日圆满结束，299元。', 'zh'],
    ['CNY', '299', '2蚊帐，299元。', 'zh'],
    ['CNY', '299', '10蚊香，299元。', 'zh'],
    ['CNY', '299', '3欧罗巴风格，299元。', 'zh'],
    ['CNY', '299', '福林路3号，299元。', 'zh'],
    ['CNY', '299', '3福林，299元。', 'zh'],
    ['CNY', '299', '100 蚊，299元。', 'zh'],
    ['KRW', '330000', '100동안 사용해요. 330,000원이에요.', 'ko'],
    ['KRW', '330000', '3동 2층이에요. 330,000원이에요.', 'ko'],
    ['KRW', '330000', '약 100 레알이에요. 330,000원이에요.', 'ko'],
    ['KRW', '330000', '2 레알 마드리드 유니폼이에요. 330,000원이에요.', 'ko'],
    ['KRW', '330000', '3 솔 칫솔이에요. 330,000원이에요.', 'ko'],
    ['KRW', '330000', '2 리라 인형이에요. 330,000원이에요.', 'ko'],
  ])('%s %s: "%s" passes', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(0);
  });

  it('3000日圆满额 is still money', () => {
    expect(currenciesOf('3000日圆满额包邮。', 'zh', 'CNY')).toEqual([['JPY']]);
  });
});

describe('review round 1', () => {
  it.each([
    ['19.99', 'Kids S$19.99, Adult $19.99.'],
    ['40', 'Sizes S/M/L$40.'],
    ['120', 'Size S$120 bundle.'],
    ['5', 'Use code SAVE10S$5.'],
    ['40', 'Plan B$40.'],
    ['40', 'Pack of 4 L$40.'],
    ['40', 'Size J$40.'],
  ])(
    'MAJOR-1. a one-letter prefix after a space or a letter is a size: USD %s "%s" passes',
    (amount, text) => {
      expect(failures('USD', amount, text, 'en')).toBe(0);
    },
  );

  it.each([
    ['S$45です。', 'ja', 'SGD'],
    ['售价S$45。', 'zh', 'SGD'],
    ['価格はS$45です。', 'ja', 'SGD'],
    ['售价J$45。', 'zh', 'JMD'],
  ])(
    'MAJOR-1. a one-letter prefix at the start or glued to CJK pins the sign: "%s"',
    (text, language, currency) => {
      expect(currenciesOf(text, language, 'USD')).toEqual([[currency]]);
      expect(failures('USD', '45', text, language)).toBe(1);
    },
  );

  it.each([
    ['TT$1,200です。', 'TTD'],
    ['BZ$1,200です。', 'BZD'],
    ['FJ$1,200です。', 'FJD'],
    ['EC$1,200です。', 'XCD'],
    ['BD$1,200です。', 'BMD'],
    ['Bds$1,200です。', 'BBD'],
    ['CI$1,200です。', 'KYD'],
    ['SI$1,200です。', 'SBD'],
    ['AU$1,200です。', 'AUD'],
    ['CA$1,200です。', 'CAD'],
    ['NZ$1,200です。', 'NZD'],
    ['MX$1,200です。', 'MXN'],
    ['SG$1,200です。', 'SGD'],
    ['HK$1,200です。', 'HKD'],
    ['NT$1,200です。', 'TWD'],
    ['J$1,200です。', 'JMD'],
  ])('every new dollar prefix: "%s" is %s', (text, currency) => {
    expect(currenciesOf(text, 'ja', 'USD')).toEqual([[currency]]);
  });

  it.each([
    ['TRY', '約150リラです。', 'ja'],
    ['ZAR', '約150ランドです。', 'ja'],
    ['VND', '約60万ドンです。', 'ja'],
    ['PEN', '約150ソルです。', 'ja'],
    ['BRL', '約150リアルです。', 'ja'],
    ['GBP', '約150パウンドです。', 'ja'],
    ['HUF', '150福林。', 'zh'],
    ['PEN', '약 150솔이에요.', 'ko'],
    ['VND', '약 60만 동이에요.', 'ko'],
    ['TRY', '약 150리라예요.', 'ko'],
    ['BRL', '약 150 레알이에요.', 'ko'],
    ['TRY', 'リラで約150です。', 'ja'],
    ['TRY', '리라로 약 150이에요.', 'ko'],
  ])('an invented price in the store own word fails: %s "%s"', (currency, text, language) => {
    expect(failures(currency, '100', text, language)).toBe(1);
  });

  it.each([
    ['TRY', 'リラで約100です。', 'ja'],
    ['TRY', '리라로 약 100이에요.', 'ko'],
    ['BRL', '約100ブラジルリアルです。', 'ja'],
    ['BRL', '約100リアルです。', 'ja'],
  ])('the store own word passes: %s "%s"', (currency, text, language) => {
    expect(failures(currency, '100', text, language)).toBe(0);
  });

  it.each([
    ['リラで約100です。', 'ja'],
    ['リラ 100です。', 'ja'],
    ['리라로 약 100이에요.', 'ko'],
    ['동 100이에요.', 'ko'],
  ])(
    'a currency-first word that needs a qualifier names nothing in another store: "%s"',
    (text, language) => {
      expect(currenciesOf(text, language, 'JPY')).toEqual([]);
    },
  );

  it.each([
    ['ZAR', '100', '2ランドセルは100ランドです。', 'ja'],
    ['TRY', '100', '2リラックスチェアは100リラです。', 'ja'],
    ['PEN', '100', '2ソルトは100ソルです。', 'ja'],
    ['VND', '500000', '3ドンキで買えます。50万ドンです。', 'ja'],
    ['VND', '500000', '3ドン・キホーテで買えます。50万ドンです。', 'ja'],
    ['SAR', '100', '3リアルレザーは100リヤルです。', 'ja'],
    ['BRL', '100', '3リアルタイム配送で100レアルです。', 'ja'],
    ['VND', '500000', '100동안 사용해요. 50만 동이에요.', 'ko'],
    ['VND', '500000', '3동 2층이에요. 50만 동이에요.', 'ko'],
    ['BRL', '100', '2 레알 마드리드 유니폼은 100헤알이에요.', 'ko'],
  ])(
    'look-alike words in a store of that currency: %s %s "%s" passes',
    (currency, amount, text, language) => {
      expect(failures(currency, amount, text, language)).toBe(0);
    },
  );

  it.each([
    ['JPY', '3980', '10パウンドのダンベルは3,980円です。', 'ja'],
    ['JPY', '3980', '5パウンドのプロテインは3,980円です。', 'ja'],
    ['JPY', '4980', '3レアルタイムは4980円です。', 'ja'],
    ['JPY', '4980', '2クローネンブルグは4980円です。', 'ja'],
    ['JPY', '4980', '3ディナールームは4980円です。', 'ja'],
    ['CNY', '199', '活动3日圆满落幕，售价199元。', 'zh'],
    ['CNY', '199', '活动3日圆满举行，售价199元。', 'zh'],
    ['CNY', '199', '活动3日圓滿閉幕，售价199元。', 'zh'],
    ['CNY', '199', '买2蚊拍，售价199元。', 'zh'],
    ['CNY', '199', '2蚊灯，售价199元。', 'zh'],
    ['CNY', '199', '3蚊液，售价199元。', 'zh'],
  ])('no false positive: %s %s "%s" passes', (currency, amount, text, language) => {
    expect(failures(currency, amount, text, language)).toBe(0);
  });

  it.each(['3000日圆满额包邮。', '3000日圆满减。'])('"%s" is still JPY money', (text) => {
    expect(currenciesOf(text, 'zh', 'CNY')).toEqual([['JPY']]);
  });

  it.each([
    ['약 100 피지 달러예요.', 'FJD'],
    ['약 100 뉴타이완 달러예요.', 'TWD'],
    ['약 100 신대만 달러예요.', 'TWD'],
    ['約100UKパウンドです。', 'GBP'],
  ])('more listed qualifiers: "%s" is %s', (text, currency) => {
    const language = /\p{Script=Hangul}/u.test(text) ? 'ko' : 'ja';
    expect(currenciesOf(text, language, 'USD')).toEqual([[currency]]);
    expect(failures('USD', '100', text, language)).toBe(1);
  });

  it('십오만 원 is the won, not an Oman qualifier', () => {
    expect(currenciesOf('십오만 원이에요.', 'ko', 'KRW')).toEqual([['KRW']]);
  });

  it('パウンド alone is a weight outside a GBP store (a qualifier makes it the pound)', () => {
    expect(currenciesOf('約100パウンドです。', 'ja', 'JPY')).toEqual([]);
    expect(currenciesOf('約100英パウンドです。', 'ja', 'JPY')).toEqual([['GBP']]);
  });

  it('accepted false positive: a weight in a GBP store, 10パウンドのダンベル, fails closed', () => {
    expect(failures('GBP', '100', '10パウンドのダンベルは100パウンドです。', 'ja')).toBe(1);
  });
});

describe('review round 2', () => {
  it.each([
    ['USD', '49', '전 사이즈 $49 동일합니다.', 'ko'],
    ['USD', '49', 'US$49 동일 적용', 'ko'],
    ['USD', '49', '$49 동봉된 쿠폰', 'ko'],
    ['USD', '45', 'US$45 동시 구매 시', 'ko'],
    ['USD', '45', '$45 솔직히 저렴해요', 'ko'],
    ['KRW', '49000', '전 사이즈 ₩49,000 동일합니다.', 'ko'],
    ['KRW', '49000', '₩49,000 동시 구매 시 할인', 'ko'],
    ['KRW', '49000', '모든 색상 ₩49,000동일', 'ko'],
    ['KRW', '49000', '₩49,000 솔직히 최저가', 'ko'],
    ['KRW', '49000', '₩49,000 랜드마크 매장', 'ko'],
    ['KRW', '49000', '₩49,000 리라 님 추천', 'ko'],
    ['JPY', '4900', '¥4,900 リラックスタイムに', 'ja'],
    ['JPY', '4900', '¥4,900 ランドセルカバー付き', 'ja'],
    ['JPY', '4900', '¥4,900 パウンドケーキ', 'ja'],
    ['JPY', '4900', '¥4,900 ソルトスクラブ', 'ja'],
    ['JPY', '4900', '¥4,900 ドンキでも', 'ja'],
    ['USD', '45', '$45 リラックスできるチェア', 'ja'],
    ['CNY', '45', '¥45 蚊香液套装', 'zh'],
    ['CNY', '45', '¥45 蚊帐', 'zh'],
    ['HKD', '45', 'HK$45 蚊帐', 'zh'],
  ])(
    'MAJOR-A. a sign price before a look-alike word stays read: %s "%s"',
    (currency, amount, text, language) => {
      expect(failures(currency, amount, text, language)).toBe(0);
      expect(failures(currency, '1', text, language)).toBe(1);
    },
  );

  it.each(['미원 3,000원', '미원 3,000원에 판매 중', '미원 1kg 3,000원'])(
    'MAJOR-B. 미원 is a brand, not US won: KRW 3000 "%s" passes',
    (text) => {
      expect(failures('KRW', '3000', text, 'ko')).toBe(0);
      expect(currenciesOf(text, 'ko', 'KRW')).toEqual([['KRW']]);
    },
  );

  it.each([
    ['约3000日圆满足需求。', 'JPY'],
    ['约3000日元满足需求。', 'JPY'],
    ['3000日元满结束。', 'JPY'],
    ['售价3日元满足条件。', 'JPY'],
  ])('MINOR-2. a number that is no day before 圆满 or 日元 stays money: "%s"', (text, currency) => {
    expect(currenciesOf(text, 'zh', 'CNY')).toEqual([[currency]]);
  });

  it.each(['サイズS$19.99です。', 'Size:S$19.99', 'サイズ: S$19.99'])(
    'MINOR-3. a size letter after katakana or a colon reads the sign alone: USD 19.99 "%s" passes',
    (text) => {
      expect(currenciesOf(text, 'ja', 'USD')).toEqual([['USD']]);
      expect(failures('USD', '19.99', text, 'ja')).toBe(0);
    },
  );

  it.each(['45 S$です。', '45S$です。', '售价45J$。'])(
    'MINOR-4. a one-letter prefix after the number never pins the sign: "%s"',
    (text) => {
      expect(currenciesOf(text, 'ja', 'SGD').flat()).not.toContain('SGD');
      expect(currenciesOf(text, 'ja', 'JMD').flat()).not.toContain('JMD');
    },
  );

  it.each([
    ['約100ニュージーランド-ドルです。', 'NZD'],
    ['約100トルコ-リラです。', 'TRY'],
    ['約100アメリカ–ドルです。', 'USD'],
  ])('a dash between the country and the currency word: "%s" is %s', (text, currency) => {
    expect(currenciesOf(text, 'ja', 'JPY')).toEqual([[currency]]);
  });
});

describe('review round 3', () => {
  it.each([
    ['订单预计15日圆通快递发出，帐篷199元。'],
    ['我们会在3日圆通发货，帐篷199元。'],
    ['15日圆领T恤上新，199元。'],
    ['活动12日圆梦价199元。'],
    ['20日圆明园门票199元。'],
    ['預計15日圓通快遞發出，帳篷199元。'],
    ['3日圆满结束，帐篷199元。'],
  ])('MAJOR-1 a day number before 日圆 and a Han word is a date: %s', (text) => {
    expect(failures('CNY', '199', text, 'zh')).toBe(0);
  });

  it.each([['5日圆满额立减，帐篷199元。'], ['3日圆满减，帐篷199元。'], ['约3000日圆满额包邮。']])(
    'a day number before 日圆满额 / 满减 stays yen money: %s',
    (text) => {
      expect(failures('CNY', '199', text, 'zh')).toBeGreaterThan(0);
    },
  );

  it.each([
    ['2025 유럽 원정 유니폼은 89,000원이에요.'],
    ['2025 페루 원정 유니폼은 89,000원이에요.'],
    ['TOP 3 피지 원인을 잡는 클렌저는 89,000원이에요.'],
    ['10 US 원피스는 89,000원이에요.'],
  ])('MAJOR-2 원 glued to a Hangul syllable after a qualifier is a word: %s', (text) => {
    expect(failures('KRW', '89000', text, 'ko')).toBe(0);
  });

  it.each([['89,000 한국원이에요.'], ['89,000 유럽 원인데 할인돼요.'], ['89,000 한국 원이에요.']])(
    'an invented won price after a qualifier still fails, whatever follows: %s',
    (text) => {
      expect(failures('KRW', '50000', text, 'ko')).toBeGreaterThan(0);
    },
  );

  it.each([['2025 EU 円安でも8,900円です。'], ['2025 サウジ円卓会議の記念品は8,900円です。']])(
    '円 glued to a Han word after a qualifier is a word: %s',
    (text) => {
      expect(failures('JPY', '8900', text, 'ja')).toBe(0);
    },
  );

  it('4K レアル映像 is a picture quality, not reais', () => {
    expect(failures('JPY', '4980', '4Kレアル映像のモニターは4,980円です。', 'ja')).toBe(0);
  });

  it('a lowercase one-letter dollar prefix after a space reads the sign alone, as the uppercase one', () => {
    expect(currenciesOf('Kids s$19.99', 'en', 'USD')).toEqual(
      currenciesOf('Kids S$19.99', 'en', 'USD'),
    );
  });

  // Accepted false positives (fail closed): a sign or code right before a look-alike word.
  it.each([
    ['KRW', 'KRW 3원색 세트는 29,000원이에요.', 'ko'],
    ['USD', 'USD 3元系电池 $49.', 'zh'],
  ])(
    'a code right before a look-alike word reads the number (accepted): %s',
    (store, text, language) => {
      expect(failures(store, store === 'KRW' ? '29000' : '49', text, language)).toBeGreaterThan(0);
    },
  );
});

describe('review round 4', () => {
  it.each([
    ['TWD', '約15日圓左右，帳篷199元。'],
    ['TWD', '手續費3日圓的手續費，帳篷199元。'],
    ['TWD', '帳篷199元，約合30日圓起。'],
    ['CNY', '约15日圆左右，帐篷199元。'],
    ['CNY', '帐篷199元，运费15日圆起。'],
    ['TWD', '運費15日圓。帳篷199元。'],
    ['CNY', '帐篷199元，约32日圆通关费。'],
  ])(
    'MAJOR-1 a day number before 日圆 and an unlisted word stays yen money: %s %s',
    (store, text) => {
      expect(failures(store, '199', text, 'zh')).toBeGreaterThan(0);
    },
  );

  it('MAJOR-1 an invented price in a JPY store with a day-number fee still fails', () => {
    expect(failures('JPY', '5980', '帳篷4980日圓，運費15日圓起。', 'zh')).toBeGreaterThan(0);
  });

  it.each([
    ['USD', '49', '$49입니다. 약 65,000 한국 원정도예요.'],
    ['USD', '49', '$49입니다. 약 65,000 한국원정도예요.'],
    ['KRW', '89000', '89,000원이에요. 배송비는 3,000 한국원정도예요.'],
    ['KRW', '89000', '89,000원이에요. 65,000 한국원정가예요.'],
  ])('MAJOR-2 원정도 / 원정가 after a qualifier stay money: %s %s', (store, amount, text) => {
    expect(failures(store, amount, text, 'ko')).toBeGreaterThan(0);
  });

  it.each([
    ['TOP 3 피지 원인이 뭔가요? 클렌저는 89,000원이에요.'],
    ['TOP 3 피지 원인은 모공이에요. 클렌저는 89,000원이에요.'],
    ['TOP 3 피지 원인으로 꼽혀요. 클렌저는 89,000원이에요.'],
    ['TOP 3 피지 원인과 해결책: 클렌저는 89,000원이에요.'],
  ])('원인 with each case ending after a qualifier is a word: %s', (text) => {
    expect(failures('KRW', '89000', text, 'ko')).toBe(0);
  });

  it.each([['2025 EU 円高でも8,900円です。'], ['2025 EU 円形のケースは8,900円です。']])(
    '円 glued to a listed Han word after a qualifier is a word: %s',
    (text) => {
      expect(failures('JPY', '8900', text, 'ja')).toBe(0);
    },
  );

  it.each([['4Kレアル画質のモニターは4,980円です。'], ['このレアル感のモニターは4,980円です。']])(
    'レアル before a picture word is no reais: %s',
    (text) => {
      expect(failures('JPY', '4980', text, 'ja')).toBe(0);
    },
  );

  it('an ISO code naming the token own currency restates it', () => {
    expect(currenciesOf('約7,500 JPY円高めです', 'ja', 'USD')).toEqual([['JPY']]);
  });
});

describe('the new forms stay linear', () => {
  it.each(['1MX', '1ニュー台湾', '1南ア', '1ユ-', '1HK$', '1 미 ', '1サウジ・', '1ランド'])(
    '"%s" repeated',
    (unit) => {
      expectLinear((scale) => {
        extractAmounts(unit.repeat(2_000 * scale), ['ja', 'en'], 'JPY');
      });
    },
  );
});
// cspell:enable
