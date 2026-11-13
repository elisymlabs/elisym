import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, stripViolations } from '../src/price-check';
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

const cny = (text: string, language = 'zh') => check('CNY', '1699', text, language).found.length;

describe('MAJOR-1. a small count + 块 is money unless a listed product noun follows', () => {
  it.each([
    ['zh', '只要5块即可'],
    ['zh', '这款9块是活动价'],
    ['zh', '9块不贵'],
    ['zh', '售价9块整'],
    ['zh', '9块以内'],
    ['zh', '9块入手'],
    ['zh', '9块拿下'],
    ['zh', '9块搞定'],
    ['zh', '9块封顶'],
    ['zh', '9块含运费'],
    ['zh', '9块免邮'],
    ['zh', '9块送收纳袋'],
    ['zh', '9块加运费'],
    ['zh', '9块已经很便宜了'],
    ['zh', '9块算便宜的'],
    ['zh', '9块非常划算'],
    ['zh', '9块超值'],
    ['zh', '9块人民币'],
    ['zh', '9块比原价便宜'],
    ['zh', '9块特价'],
    ['zh', '9块秒杀'],
    ['zh', '9块哈'],
    ['zh-TW', '9塊是活動價'],
    ['zh-TW', '9塊不貴'],
    ['zh-TW', '9塊即可'],
    ['zh', '切成两半后9块。'],
  ])('%s: "%s" fails in a CNY store at 1699', (language, text) => {
    expect(cny(text, language)).toBe(1);
  });

  it.each([
    '附赠两块可替换滤芯',
    '配有两块可拆卸挡板',
    '两块可水洗内胆',
    '内含两块便携垫',
    '两块便携式太阳能板',
    '套装含两块太阳能板',
    '两块真皮护垫',
    '两块能量棒',
    '两块元宵',
    '三块香皂',
    '附赠一块抹布',
  ])('"%s" stays pieces', (text) => {
    expect(cny(text)).toBe(0);
  });

  /**
   * Accepted false positives: a product noun not in the list strips one sentence: add it to
   * PIECE_NOUN_STARTS.
   */
  it.each([
    '一块上好的木板',
    '两块和牛牛排',
    '两块最新款电池',
    '两块下垫',
    '分成两块收纳。',
    '送你一块小毛巾。',
    '由三块组成。',
  ])('accepted false positive: "%s" is read as money', (text) => {
    expect(cny(text)).toBe(1);
  });

  it('the split rule: a single 切 counts, and only right before the count', () => {
    expect(cny('切两块。')).toBe(0);
    expect(cny('切成两半后9块。')).toBe(1);
  });
});

describe('MINOR. a list marker goes with its stripped sentence', () => {
  it.each([
    ['1．这款售价1599元。2．包邮。', '2．包邮。'],
    ['１．售价1599元\n２．包邮。', '２．包邮。'],
    ['1. 这款售价1599元。 2. 包邮。', '2. 包邮。'],
  ])('"%s" keeps "%s" and no lone marker', (text, kept) => {
    const { answer, found } = check('CNY', '1699', text, 'zh');
    expect(found).toHaveLength(1);
    const stripped = stripViolations(answer, found, 'zh-CN').text;
    expect(stripped.startsWith(kept)).toBe(true);
    expect(stripped).not.toMatch(/^[1１][.．]/u);
  });
});
