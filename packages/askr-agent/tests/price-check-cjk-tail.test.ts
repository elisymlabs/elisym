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
    ['約100パウンドです。', 'ja', ['GBP']],
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
    ['JPY', '100', '約100パウンドです。', 'ja'],
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
