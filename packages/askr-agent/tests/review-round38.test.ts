import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { checkPrices, stripViolations } from '../src/price-check';
import { CONFIG, expectLinear, item } from './fixtures';

function store(currency: string, amount: string, language: string) {
  const tent = item({ d: 'tent', title: 'Ridge tent', price: { amount, currency } });
  return {
    tent,
    catalog: new StoreCatalog({ ...CONFIG, currency, language }, undefined, [tent], []),
  };
}

function check(currency: string, amount: string, text: string, language: string) {
  const built = store(currency, amount, language);
  const answer: Answer = {
    type: 'answer',
    ask_id: '0'.repeat(32),
    session_end: 1,
    text,
    components: [{ type: 'products', picks: [{ address: `30402:${built.tent.author}:tent` }] }],
    chips: [],
  };
  const found = checkPrices(answer, {
    storeCurrency: currency,
    items: built.catalog.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, 'en'],
  });
  return { answer, found };
}

const violations = (currency: string, amount: string, text: string, language: string) =>
  check(currency, amount, text, language).found.length;
const cny = (text: string) => violations('CNY', '249', text, 'zh');

describe('1. a count before 块 ending a clause is always money (no stock-talk exemption)', () => {
  it.each([
    '需要9块',
    '这款只有9块。',
    '用券后还剩5块。',
    '离包邮还有5块。',
    '首单送5块。',
    '满100送5块。',
    '人民币只有9块。',
    '需要的话还有两块。',
  ])('money "%s" fails in a CNY store at 249', (text) => {
    expect(cny(text)).toBe(1);
  });

  /**
   * Accepted false positives, fail closed (round 38): a count before 块 ending a clause cannot
   * be told from a price in Chinese ("需要两块" vs "需要9块"). A false positive strips one
   * sentence and appends a localized pointer to the cards; a fail-open would publish a wrong
   * price in prose. Only an explicit split (切成, 拆成, 切, 拆; 分成 for a small count) stays
   * pieces.
   */
  it.each([
    '只剩一块了。',
    '只剩最后一块了！',
    '库存只剩3块了。',
    '套装里有三块呢。',
    '建议多带两块吧。',
    '一盒有六块呢。',
    '这款地垫送两块哦。',
    '免费送两块。',
    '只剩一塊了。',
    '需要两块吧。',
    '一块就够用了。',
    '两块就能铺满帐篷底部。',
    '买两块吗？',
    '電池兩塊就夠了。',
    '建议买2块，一块备用。',
    '变成两块。',
    '一盒六块。',
  ])('accepted false positive: "%s" is read as money', (text) => {
    expect(cny(text)).toBe(1);
  });

  it.each(['切成两块就好。', '拆成12块。', '可以切成四块。', '分成两块。'])(
    'an explicit split stays pieces: "%s"',
    (text) => {
      expect(cny(text)).toBe(0);
    },
  );

  it('分成 with a larger count is money', () => {
    expect(cny('分成300块。')).toBe(1);
  });
});

describe('2. the measure-word rule stays, but money nouns after 块 keep it money', () => {
  it.each(['两块砧板一起卖。', '三块香皂装在盒子里。', '分成两块收纳。', '附赠一块抹布。'])(
    '"%s" is pieces',
    (text) => {
      expect(cny(text)).toBe(0);
    },
  );

  it.each([
    '送5块券',
    '下单送5块红包',
    '赠5块无门槛券',
    '补5块差价',
    '返5块现金',
    '减5块运费',
    '送5块钱',
  ])('"%s" is money', (text) => {
    expect(cny(text)).toBe(1);
  });
});

describe('MINOR', () => {
  it('the split rule looks at a bounded window: linear in the text length', () => {
    expectLinear((scale) => {
      check('CNY', '249', '1块了，'.repeat(500 * scale), 'zh');
    });
  });

  it.each(['Model RMB-200 is in stock.', 'Model NTD-12 adapter.', 'Model RMB:200 is new.'])(
    'a code with a hyphen or colon before the number is a model name: "%s"',
    (text) => {
      expect(violations('USD', '249', text, 'en')).toBe(0);
    },
  );

  it.each(['The RMB200 kit fits.', 'Rated NTD 12 for safety.', 'Ships with 3 NTD adapters.'])(
    'accepted false positive (fail closed): "%s" is read as money',
    (text) => {
      expect(violations('USD', '249', text, 'en')).toBe(1);
    },
  );

  it('a full-width point between letters splits, between digits does not', () => {
    const letters = check('CNY', '249', '这款很轻．价格199元。', 'zh');
    expect(letters.found).toHaveLength(1);
    expect(stripViolations(letters.answer, letters.found, 'zh-CN').text).toContain('这款很轻．');
    const afterNumber = check('CNY', '249', '数量是3．价格199元。', 'zh');
    expect(stripViolations(afterNumber.answer, afterNumber.found, 'zh-CN').text).toContain(
      '数量是3．',
    );
    expect(violations('CNY', '1.5', '价格是1．5元。', 'zh')).toBe(0);
    expect(violations('CNY', '1.5', '价格是１．５元。', 'zh')).toBe(0);
  });
});

describe('a price continued after 块 is money, not a counted noun', () => {
  it.each([
    '5块很便宜',
    '这个5块太划算了',
    '9块真值',
    '5块就能买',
    '5块也行',
    '5块左右',
    '5块一个',
    '5块和10块两种',
    '3块都可以',
    '5块还送赠品',
  ])('"%s" fails in a CNY store at 249', (text) => {
    expect(cny(text)).toBe(1);
  });

  it.each(['两块砧板', '三块香皂', '附赠一块抹布', '分成两块收纳'])('"%s" stays pieces', (text) => {
    expect(cny(text)).toBe(0);
  });

  // Accepted false positive (fail closed): a degree word after 块 continues a price as often.
  it('分成两块很方便携带 is read as money', () => {
    expect(cny('分成两块很方便携带。')).toBe(1);
  });
});
