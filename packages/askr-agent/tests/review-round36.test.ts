import type { Answer } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { LlmError, type LlmProvider } from '../src/llm/types';
import { cardsPointer, checkPrices, stripViolations } from '../src/price-check';
import { TurnError, runTurn } from '../src/turn';
import { CONFIG, NOW, catalog, item } from './fixtures';

function store(currency: string, amount: string, language: string) {
  const tent = item({ d: 'tent', title: 'Ridge tent', price: { amount, currency } });
  return {
    tent,
    catalog: new StoreCatalog({ ...CONFIG, currency, language }, undefined, [tent], []),
  };
}

function answerOf(text: string, author: string): Answer {
  return {
    type: 'answer',
    ask_id: '0'.repeat(32),
    session_end: 1,
    text,
    components: [{ type: 'products', picks: [{ address: `30402:${author}:tent` }] }],
    chips: [],
  };
}

function contextOf(currency: string, language: string, built: ReturnType<typeof store>) {
  return {
    storeCurrency: currency,
    items: built.catalog.items,
    visitorMessages: [],
    policyPassages: [],
    locales: [language, 'en'],
  };
}

/** Violations of `text` in a store of `currency` whose one product, shown as a card, costs `amount`. */
function violations(currency: string, amount: string, text: string, language: string): number {
  const built = store(currency, amount, language);
  return checkPrices(answerOf(text, built.tent.author), contextOf(currency, language, built))
    .length;
}

const usd = (text: string, language: string) => violations('USD', '249', text, language);

describe('MAJOR-1. a small count before 块 ending a clause is stock talk unless a price word leads', () => {
  it.each([
    '只剩一块了。',
    '只剩最后一块了！',
    '库存只剩3块了。',
    '套装里有三块呢。',
    '建议多带两块吧。',
    '一盒有六块呢。',
    '这款地垫送两块哦。',
    '切成两块就好。',
    '只剩一塊了。',
  ])('"%s" is no amount in USD and CNY stores', (text) => {
    expect(usd(text, 'zh')).toBe(0);
    expect(violations('CNY', '249', text, 'zh')).toBe(0);
  });

  // Fail-closed decisions (round 37): no stock verb right before the count, so money. A false
  // positive strips one sentence and appends the pointer; a fail-open passes a wrong price.
  it.each([
    '一块就够用了。',
    '两块就能铺满帐篷底部。',
    '买两块吗？',
    '電池兩塊就夠了。',
    '建议买2块，一块备用。',
  ])('accepted false positive: "%s" is read as money in a CNY store', (text) => {
    expect(violations('CNY', '249', text, 'zh')).toBe(1);
  });

  it.each([
    '便宜5块呢',
    '差5块就包邮',
    '要5块吗',
    '才8块啊',
    '便宜5块了',
    '只要5块吧',
    '运费5块呀',
  ])('"%s" stays money in a CNY store at 249', (text) => {
    expect(violations('CNY', '249', text, 'zh')).toBe(1);
  });
});

describe('MAJOR-2. a larger count after a conversion or a bare 成 / 分 is money', () => {
  it.each(['换算成1800块。', '折合成1800块。', '按汇率换算成1800块，', '合成1800块。'])(
    'USD store: "%s" fails',
    (text) => {
      expect(usd(text, 'zh')).toBe(1);
    },
  );

  it.each([
    '打折后变成199块。',
    '降价后变成一百九十九块。',
    '现在降成199块。',
    '每人分100块。',
    '两人平分1800块。',
    '分成300块。',
  ])('CNY store at 1699: "%s" fails', (text) => {
    expect(violations('CNY', '1699', text, 'zh')).toBe(1);
  });

  it('an explicit split takes a larger count only at a clause end', () => {
    expect(violations('CNY', '1699', '切成12块。', 'zh')).toBe(0);
    expect(violations('CNY', '1699', '切成12块钱', 'zh')).toBe(1);
    expect(violations('CNY', '1699', '切成12块很方便', 'zh')).toBe(1);
  });
});

describe('MAJOR-3. RMB and NTD are currencies', () => {
  it.each([
    '大约1800 RMB。',
    '大约RMB 1800。',
    '约合1800RMB。',
    'About RMB 1,800.',
    '約NTD 7,800。',
    '約7,800 NTD。',
    'about 1800 rmb',
  ])('USD store: "%s" fails', (text) => {
    expect(usd(text, 'zh')).toBe(1);
  });

  it('store-currency forms pass', () => {
    expect(violations('CNY', '1799', '售价RMB 1,799。', 'zh')).toBe(0);
    expect(violations('CNY', '1799', '售价1799 RMB。', 'zh')).toBe(0);
    expect(violations('TWD', '7990', '售價NTD 7,990。', 'zh-TW')).toBe(0);
  });

  it('新币 is the Singapore dollar', () => {
    expect(violations('CNY', '199', '199新币', 'zh')).toBe(1);
    expect(violations('SGD', '199', '199新币', 'zh')).toBe(0);
  });
});

describe('MINOR', () => {
  it.each([
    ['zh', '199新加坡元'],
    ['zh', '199加拿大元'],
    ['zh', '199澳大利亚元'],
    ['ja', '199カナダドル'],
    ['ja', '199豪ドル'],
    ['ja', '199香港ドル'],
    ['ja', '199台湾ドル'],
    ['ko', '199캐나다 달러'],
    ['ko', '199캐나다달러'],
    ['ko', '199호주달러'],
    ['ko', '199홍콩달러'],
  ])('%s: compound currency "%s" fails in a USD store at 199', (language, text) => {
    expect(violations('USD', '199', text, language)).toBe(1);
  });

  it.each(['差不多一千八左右人民币', '大概1800上下人民币'])('"%s" reads (no value)', (text) => {
    expect(usd(text, 'zh')).toBe(1);
    expect(violations('CNY', '1800', text, 'zh')).toBe(1);
  });

  it.each([
    ['ja', '一円玉サイズのボタンです。'],
    ['ja', '百円ショップでも買えます。'],
    ['ko', '백 원짜리 동전 크기예요.'],
    ['zh', '一元复始，万象更新。'],
  ])('%s: "%s" is no amount', (language, text) => {
    expect(usd(text, language)).toBe(0);
  });

  it('a CJK sentence end splits sentences: only the bad one is stripped, with a zh pointer', () => {
    const built = store('CNY', '1699', 'zh');
    const text =
      '这款手表防水50米，表带可以更换。只剩一块了，只要199元。需要的话我可以再推荐两款。';
    const answer = answerOf(text, built.tent.author);
    const found = checkPrices(answer, contextOf('CNY', 'zh', built));
    expect(found).toHaveLength(1);
    const stripped = stripViolations(answer, found, 'zh-CN');
    expect(stripped.text).toContain('这款手表防水50米，表带可以更换。');
    expect(stripped.text).toContain('需要的话我可以再推荐两款。');
    expect(stripped.text).not.toContain('199');
    expect(stripped.text).toContain(cardsPointer('zh-CN'));
  });

  it('cards pointers in Chinese, Japanese and Korean', () => {
    expect(cardsPointer('zh-CN')).toBe('价格请看商品卡片。');
    expect(cardsPointer('zh-TW')).toBe('價格請見商品卡片。');
    expect(cardsPointer('zh-Hant-HK')).toBe('價格請見商品卡片。');
    expect(cardsPointer('ja-JP')).toBe('価格はカードをご覧ください。');
    expect(cardsPointer('ko')).toBe('가격은 카드를 확인해 주세요.');
  });
});

describe('a price-check re-run that fails on anything but a stop reason fails the turn', () => {
  it('a network or provider error in the re-run is a turn error', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      model: 'flaky-retry',
      turn: async () => {
        calls += 1;
        if (calls > 1) {
          throw new LlmError('status 503', 503);
        }
        return {
          text: 'It is on sale for $99.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
        };
      },
    };
    const error = await runTurn({
      catalog: catalog(),
      provider,
      history: [],
      askId: 'a'.repeat(32),
      text: 'something warm',
      sessionEnd: NOW + 3_600,
      now: NOW,
      earlierVisitorMessages: [],
      earlierPolicyPassages: [],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TurnError);
    expect(error instanceof TurnError ? error.reason : undefined).toBeInstanceOf(LlmError);
  });
});

describe('security: stock talk needs a stock word, not only the absence of a price word', () => {
  it.each([
    '这个卖5块呢',
    '现价8块了',
    '特价5块哦',
    '原价9块吧',
    '优惠后6块啦',
    '售5块',
    '降到5块了',
    '打折5块呀',
    '一共5块吧',
    '总共5块呢',
    '这个5块呢',
    '剩下的一共5块吧',
  ])('"%s" is money in a CNY store at 249', (text) => {
    expect(violations('CNY', '249', text, 'zh')).toBe(1);
  });
});
