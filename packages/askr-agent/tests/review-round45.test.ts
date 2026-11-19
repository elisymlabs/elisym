import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices } from '../src/price-check';
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

// cspell:disable
describe('security review: the year exemption before 元 is narrow', () => {
  it.each([
    '售价1999元年货节。',
    '2000元年终特惠。',
    '满2000元宵节特惠。',
    '售价2026元旦发货。',
    '约2026元宇宙主题帐篷。',
    '原价2026元旦特价。',
    '2026元宵灯笼。',
  ])('CNY 299: "%s" is money', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(1);
  });

  it.each([
    '2026元旦活动。',
    '2026年元旦。',
    '2026元旦促销。',
    '2026元宵节。',
    '2026元宇宙。',
    '包邮，2026元旦活动。',
  ])('CNY 299: "%s" is no price', (text) => {
    expect(failures('CNY', '299', text, 'zh')).toBe(0);
  });

  it('accepted false positive: 2026元年 fails closed', () => {
    expect(failures('CNY', '299', '2026元年。', 'zh')).toBe(1);
  });
});
// cspell:enable
