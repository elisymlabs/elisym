import { describe, expect, it } from 'vitest';
import {
  MAX_SUBUNIT_DIGITS,
  coinAmountText,
  coinDecimals,
  fromSubunits,
  toSubunits,
  txExplorer,
} from '../../src/hosted/lib/amounts';
import { fullConfig } from '../../src/hosted/lib/config-input';
import {
  AMOUNT_PROBLEMS,
  BAD_TX,
  MAX_REFUND_TX,
  NO_COIN,
  NO_TX,
  handInput,
  refundCoins,
} from '../../src/hosted/lib/hand-answer';
import {
  type OrderEntry,
  handText,
  orderEntries,
  utcText,
  visibleEntries,
  webhookText,
} from '../../src/hosted/lib/orders';
import {
  HOSTED_CSV_COLUMNS,
  hostedCsvFileName,
  hostedOrdersCsv,
} from '../../src/hosted/lib/orders-csv';
import type { OrderView, OrdersView } from '../../src/hosted/lib/types';
import { storeView } from './fakes';
import { BASE_SEPOLIA_USDC, NOW, SOLANA_ADDRESS, SOLANA_USDC, storeConfig } from './store-fakes';

const BUYER = 'b'.repeat(64);
const TX = '5'.repeat(88);

function order(orderId: string, overrides: Partial<OrderView> = {}): OrderView {
  return {
    key: `${BUYER}:${orderId}`,
    buyerPubkey: BUYER,
    orderId,
    product: `30402:${'s'.repeat(64)}:socks`,
    productTitle: 'Socks',
    createdAt: NOW,
    reportedTxs: [],
    ...overrides,
  };
}

function ordersView(overrides: Partial<OrdersView> = {}): OrdersView {
  return { orders: [], answeredByHand: {}, unresolvedPayments: [], ...overrides };
}

describe('coin amounts in subunits', () => {
  it.each([
    [6, '1', '1000000'],
    [6, '12.5', '12500000'],
    [6, '0.000001', '1'],
    [6, ' 3.10 ', '3100000'],
    [9, '1', '1000000000'],
    [9, '0.000000001', '1'],
    [9, '2.123456789', '2123456789'],
    [18, '1', '1000000000000000000'],
    [18, '0.000000000000000001', '1'],
    [18, '123456789.123456789123456789', '123456789123456789123456789'],
    [0, '7', '7'],
  ])('decimals %i: %s is %s subunits', (decimals, typed, subunits) => {
    expect(toSubunits(typed, decimals)).toEqual({ ok: true, subunits });
  });

  it.each([
    [6, '0.0000001', 'decimals'],
    [9, '0.0000000001', 'decimals'],
    [18, '0.0000000000000000001', 'decimals'],
    [0, '1.5', 'decimals'],
    [6, '0', 'zero'],
    [6, '0.000000', 'zero'],
    [18, '0.0', 'zero'],
    [6, '-1', 'negative'],
    [18, ' -0.5', 'negative'],
    [6, '', 'format'],
    [6, '1.', 'format'],
    [6, '.5', 'format'],
    [6, '1e3', 'format'],
    [6, '1,5', 'format'],
    [6, '+1', 'format'],
    [6, 'NaN', 'format'],
    [6, 'Infinity', 'format'],
    [0, '1'.repeat(MAX_SUBUNIT_DIGITS + 1), 'large'],
    [18, `1${'0'.repeat(MAX_SUBUNIT_DIGITS - 18)}`, 'large'],
  ])('decimals %i: refuses %j as %s', (decimals, typed, problem) => {
    expect(toSubunits(typed, decimals)).toEqual({ ok: false, problem });
  });

  it('takes the largest amount the server takes, and no more', () => {
    const largest = '9'.repeat(MAX_SUBUNIT_DIGITS);
    expect(toSubunits(largest, 0)).toEqual({ ok: true, subunits: largest });
    expect(toSubunits(`${'9'.repeat(MAX_SUBUNIT_DIGITS - 18)}.${'9'.repeat(18)}`, 18)).toEqual({
      ok: true,
      subunits: largest,
    });
  });

  it('reads subunits back in whole units, trailing zeros trimmed', () => {
    expect(fromSubunits('12500000', 6)).toBe('12.5');
    expect(fromSubunits('1', 9)).toBe('0.000000001');
    expect(fromSubunits('1000000000000000000', 18)).toBe('1');
    expect(fromSubunits('123456789123456789123456789', 18)).toBe('123456789.123456789123456789');
  });

  it('knows the decimals, the amount and the explorer of a registry coin only', () => {
    expect(coinDecimals(SOLANA_USDC)).toBe(6);
    expect(coinDecimals('solana:x/token:y')).toBeUndefined();
    expect(coinAmountText('1500000', SOLANA_USDC)).toBe('1.5 USDC');
    expect(coinAmountText('15', 'unknown')).toBe('15 subunits');
    expect(txExplorer(SOLANA_USDC, TX)).toBe(`https://explorer.solana.com/tx/${TX}?cluster=devnet`);
    expect(txExplorer(BASE_SEPOLIA_USDC, '0xab')).toBe('https://sepolia.basescan.org/tx/0xab');
    expect(txExplorer(SOLANA_USDC, 'a/b?c')).toBe(
      'https://explorer.solana.com/tx/a%2Fb%3Fc?cluster=devnet',
    );
    expect(txExplorer('unknown', TX)).toBeUndefined();
  });
});

describe('hand answers', () => {
  const refund = { kind: 'refunded' as const, tx: TX, amount: '12.5', caip19: SOLANA_USDC };

  it('completes with nothing else', () => {
    expect(handInput({ ...refund, kind: 'complete', tx: '', amount: '' })).toEqual({
      ok: true,
      input: { kind: 'complete' },
    });
  });

  it('sends a refund in subunits of its coin, with the coin', () => {
    expect(handInput({ ...refund, tx: ` ${TX} ` })).toEqual({
      ok: true,
      input: { kind: 'refunded', tx: TX, amount: '12500000', asset: SOLANA_USDC },
    });
  });

  it.each([
    [{ tx: '' }, NO_TX],
    [{ tx: '   ' }, NO_TX],
    [{ tx: 'a b' }, BAD_TX],
    [{ tx: 'a'.repeat(MAX_REFUND_TX + 1) }, BAD_TX],
    [{ caip19: '' }, NO_COIN],
    [{ caip19: 'solana:x/token:y' }, NO_COIN],
    [{ amount: '0' }, AMOUNT_PROBLEMS.zero],
    [{ amount: '-2' }, AMOUNT_PROBLEMS.negative],
    [{ amount: '0.0000001' }, AMOUNT_PROBLEMS.decimals],
    [{ amount: 'ten' }, AMOUNT_PROBLEMS.format],
  ])('refuses %j', (edit, message) => {
    expect(handInput({ ...refund, ...edit })).toEqual({ ok: false, message });
  });

  it('takes a refund transaction of the longest length the server takes', () => {
    const tx = 'a'.repeat(MAX_REFUND_TX);
    expect(handInput({ ...refund, tx })).toMatchObject({ ok: true, input: { tx } });
  });

  it('offers the store payout coins the registry knows, live ones first, each once', () => {
    const view = storeView({
      activePayouts: {
        createdAt: NOW,
        payouts: [{ caip19: BASE_SEPOLIA_USDC, address: '0xab' }],
      },
      config: storeConfig({
        draftPayouts: [
          { caip19: SOLANA_USDC, address: SOLANA_ADDRESS },
          { caip19: BASE_SEPOLIA_USDC, address: '0xab' },
          { caip19: 'solana:x/token:y', address: SOLANA_ADDRESS },
        ],
      }),
    });
    expect(refundCoins(view)).toEqual([
      { caip19: BASE_SEPOLIA_USDC, label: 'USDC on Base Sepolia' },
      { caip19: SOLANA_USDC, label: 'USDC on Solana' },
    ]);
    expect(refundCoins(storeView())).toEqual([]);
  });
});

describe('order entries', () => {
  const paid = {
    signature: TX,
    amount: '5000000',
    fee: '50000',
    caip19: SOLANA_USDC,
    medium: 'solana',
    blockTime: NOW,
  };

  it('derives each state: answered by hand, delivered, paid, unresolved, open', () => {
    const view = ordersView({
      orders: [
        order('open', { createdAt: NOW - 1 }),
        order('unresolved', { createdAt: NOW - 2 }),
        order('paid', { createdAt: NOW - 3, paid }),
        order('delivered', { createdAt: NOW - 4, paid, deliveredAt: NOW }),
        order('answered', { createdAt: NOW - 5, deliveredAt: NOW }),
      ],
      answeredByHand: { [`${BUYER}:answered`]: { kind: 'delivered' } },
      unresolvedPayments: [
        { key: `${BUYER}:unresolved`, tx: TX, at: NOW },
        { key: `${BUYER}:answered`, tx: TX, at: NOW },
      ],
    });
    expect(orderEntries(view).map((entry) => [entry.orderId, entry.state])).toEqual([
      ['open', 'open'],
      ['unresolved', 'unresolved'],
      ['paid', 'paid'],
      ['delivered', 'delivered'],
      ['answered', 'answered'],
    ]);
  });

  it('lists the newest first whatever the order, then the closed ones answered by hand', () => {
    const view = ordersView({
      orders: [
        order('old', { createdAt: 1 }),
        order('new', { createdAt: 3 }),
        order('mid', { createdAt: 2 }),
      ],
      answeredByHand: {
        [`${BUYER}:zeta`]: { kind: 'refunded', tx: TX, amount: '1', caip19: SOLANA_USDC },
        [`${BUYER}:alpha:with:colons`]: { kind: 'delivered' },
      },
    });
    const entries = orderEntries(view);
    expect(entries.map((entry) => entry.orderId)).toEqual([
      'new',
      'mid',
      'old',
      'alpha:with:colons',
      'zeta',
    ]);
    expect(entries[3]).toEqual({
      key: `${BUYER}:alpha:with:colons`,
      orderId: 'alpha:with:colons',
      buyerPubkey: BUYER,
      state: 'answered',
      hand: { kind: 'delivered' },
      unresolved: [],
    });
  });

  it('orders the same time by key, and never takes an inherited key as a hand answer', () => {
    const view = ordersView({
      orders: [order('b'), order('a'), order('constructor'), order('x', { key: 'toString' })],
    });
    expect(orderEntries(view).map((entry) => [entry.orderId, entry.state])).toEqual([
      ['a', 'open'],
      ['b', 'open'],
      ['constructor', 'open'],
      ['x', 'open'],
    ]);
  });

  it('filters by state and searches email, customer ref and order id, any case', () => {
    const entries = orderEntries(
      ordersView({
        orders: [
          order('one', { email: 'Ann@Example.com', createdAt: 3 }),
          order('two', { customerRef: 'ACC-77', createdAt: 2, paid }),
          order('three-ann', { createdAt: 1 }),
        ],
      }),
    );
    const ids = (shown: OrderEntry[]) => shown.map((entry) => entry.orderId);
    expect(ids(visibleEntries(entries, 'all', ''))).toEqual(['one', 'two', 'three-ann']);
    expect(ids(visibleEntries(entries, 'all', ' ann '))).toEqual(['one', 'three-ann']);
    expect(ids(visibleEntries(entries, 'all', 'acc-7'))).toEqual(['two']);
    expect(ids(visibleEntries(entries, 'paid', ''))).toEqual(['two']);
    expect(ids(visibleEntries(entries, 'open', 'ann'))).toEqual(['one', 'three-ann']);
    expect(ids(visibleEntries(entries, 'paid', 'ann'))).toEqual([]);
    expect(ids(visibleEntries(entries, 'all', 'socks'))).toEqual([]);
  });

  it('says webhook states and hand answers in fixed words only', () => {
    expect(webhookText({ state: 'sent', attempts: 1, lastStatus: 200 })).toBe(
      'sent; 1 attempt, last answer HTTP 200',
    );
    expect(webhookText({ state: 'pending', attempts: 3 })).toBe(
      'sending (retried until it is taken or its deadline passes); 3 attempts',
    );
    expect(webhookText({ state: 'failed', attempts: 0 })).toBe(
      'failed (its deadline passed); 0 attempts',
    );
    const hostile = {
      state: 'toString',
      attempts: Number.NaN,
      lastStatus: 'x' as unknown as number,
    };
    expect(webhookText(hostile)).toBe('unknown; 0 attempts');
    expect(webhookText({ state: '<b>leak</b>', attempts: 2 })).toBe('unknown; 2 attempts');
    expect(handText({ kind: 'delivered' })).toBe('completed by hand');
    expect(handText({ kind: 'refunded' })).toBe('refunded by hand');
    expect(handText({ kind: 'constructor' })).toBe('answered by hand');
    expect(utcText(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('the orders CSV', () => {
  it('writes one formula-safe line per entry, amounts in whole units', () => {
    const entries = orderEntries(
      ordersView({
        orders: [
          order('=cmd', {
            createdAt: 0,
            email: '+1@example.com',
            customerRef: '@ref',
            productTitle: '-Socks "warm"',
            paid: {
              signature: TX,
              amount: '5000000',
              fee: '50000',
              caip19: SOLANA_USDC,
              medium: 'solana',
              blockTime: 1,
            },
            deliveredAt: 60,
            webhook: { state: 'sent', attempts: 1, lastStatus: 200 },
            reportedTxs: ['r1', 'r2'],
          }),
        ],
        answeredByHand: {
          [`${BUYER}:gone`]: { kind: 'refunded', tx: 't1', amount: '2500000', caip19: SOLANA_USDC },
          [`${BUYER}:raw`]: { kind: 'refunded', tx: 't2', amount: '7' },
        },
        unresolvedPayments: [{ key: `${BUYER}:gone`, tx: 'u1', at: 1 }],
      }),
    );
    const csv = hostedOrdersCsv(entries);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('');
    expect(lines[0]).toBe(HOSTED_CSV_COLUMNS.map((column) => `"${column}"`).join(','));
    expect(lines[1]).toBe(
      [
        '1970-01-01T00:00:00.000Z',
        "'=cmd",
        BUYER,
        `30402:${'s'.repeat(64)}:socks`,
        `'-Socks ""warm""`,
        "'+1@example.com",
        "'@ref",
        'delivered',
        '5 USDC',
        '0.05 USDC',
        SOLANA_USDC,
        TX,
        '1970-01-01T00:01:00.000Z',
        'sent; 1 attempt, last answer HTTP 200',
        'r1; r2',
        '',
        '',
        '',
        '',
        '',
      ]
        .map((cell) => `"${cell}"`)
        .join(','),
    );
    expect(lines[2]).toBe(
      [
        '',
        'gone',
        BUYER,
        '',
        '',
        '',
        '',
        'answered by hand',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'u1',
        'refunded by hand',
        '2.5 USDC',
        SOLANA_USDC,
        't1',
      ]
        .map((cell) => `"${cell}"`)
        .join(','),
    );
    expect(lines[3]).toContain('"7 subunits","","t2"');
  });

  it('names the file by the store and the day', () => {
    expect(hostedCsvFileName('abcdef0123456789', new Date('2026-11-24T23:00:00Z'))).toBe(
      'paycore-orders-abcdef01-2026-11-24.csv',
    );
  });
});

describe('the full config', () => {
  const config = storeConfig({ webhookUrl: 'https://shop.example.com/hook', revision: 4 });

  it('keeps the webhook URL unless the edit sets or clears it', () => {
    expect(fullConfig(config, {}).webhookUrl).toBe('https://shop.example.com/hook');
    expect(fullConfig(config, { webhookUrl: 'https://new.example.com/h' }).webhookUrl).toBe(
      'https://new.example.com/h',
    );
    expect(fullConfig(config, { webhookUrl: null }).webhookUrl).toBeNull();
    expect(fullConfig(storeConfig(), {}).webhookUrl).toBeNull();
    expect(fullConfig(config, {}).expectedRevision).toBe(4);
  });
});
