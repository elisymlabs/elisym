import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { PIECE_NOUN_STARTS, checkPrices, stripViolations } from '../src/price-check';
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

const cny = (text: string, amount = '8') => check('CNY', amount, text, 'zh').found.length;

describe('MAJOR-1. no listed noun may start with a word that continues a price', () => {
  it.each([
    '鸡蛋5块和牛奶8块。',
    '帆布包5块和牛皮包8块都有货。',
    '涤纶款5块和牛津布款8块。',
    '这款5块和牛仔裤一起买更划算。',
    '5块和牛奶。',
    '9块元宵节特价。',
    '9块元宵節特價。',
    '9块加厚款。',
  ])('"%s" is money in a CNY store at 8', (text) => {
    expect(cny(text)).toBe(1);
  });

  it('两块元宵 is still pieces', () => {
    expect(cny('两块元宵。')).toBe(0);
  });
});

describe('every listed noun counts pieces', () => {
  it.each([...PIECE_NOUN_STARTS])('附赠两块%s… is pieces', (noun) => {
    expect(cny(`附赠两块${noun}。`)).toBe(0);
  });

  it.each([
    '十块实木砧板',
    '两块电池',
    '三块木板',
    '两块地垫',
    '两块墊子',
    '兩塊護墊',
    '一块布',
    '两块皮革',
    '两块防滑垫',
    '两块防潮垫',
    '两块面板',
    '两块地墊',
  ])('"%s" is pieces', (text) => {
    expect(cny(text)).toBe(0);
  });

  it.each(['三块装更划算。', '您可以先拿一块试试。'])(
    'accepted false positive (fail closed): "%s" is read as money',
    (text) => {
      expect(cny(text)).toBe(1);
    },
  );
});

describe('list markers', () => {
  it('a marker before a kept sentence stays; only the stripped one loses its marker', () => {
    const { answer, found } = check('CNY', '1699', '1．包邮。2．这款售价1599元。', 'zh');
    expect(found).toHaveLength(1);
    expect(stripViolations(answer, found, 'zh-CN').text).toBe('1．包邮。 价格请看商品卡片。');
  });

  it('a full-width ） marker on its own line goes with its stripped line', () => {
    const { answer, found } = check('CNY', '1699', '１）\n这款售价1599元。\n２）\n包邮。', 'zh');
    expect(found).toHaveLength(1);
    const stripped = stripViolations(answer, found, 'zh-CN').text;
    expect(stripped.startsWith('２）')).toBe(true);
    expect(stripped).not.toContain('１）');
  });

  it('a four-digit number with a point is no list marker', () => {
    const { answer, found } = check('CNY', '1699', '2024. 这款售价1599元。', 'zh');
    expect(found).toHaveLength(1);
    expect(stripViolations(answer, found, 'zh-CN').text).toContain('2024.');
  });
});
