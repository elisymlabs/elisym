import { readFileSync } from 'node:fs';
import { parseCaip19 } from '@elisym/commerce';
import { totalsOf } from '@merchant-admin-core/history';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Charts } from '../src/components/Charts';
import { CreditedChart } from '../src/components/CreditedChart';
import { OrdersDonut } from '../src/components/OrdersDonut';
import { Overview } from '../src/components/Overview';
import { StatusStrip } from '../src/components/StatusStrip';
import { Totals } from '../src/components/Totals';
import {
  LONG_SPAN_DAYS,
  OTHER_DOTS,
  OTHER_STROKES,
  STATE_DOTS,
  STATE_FILLS,
  SHORT_SPAN_DAYS,
  creditedByDay,
  creditedCoins,
  dayLabel,
  orderSlices,
  peakOf,
  ratioOf,
  spanDays,
  statusParts,
  sumOf,
  unchartedCredits,
  utcDay,
} from '../src/lib/charts';
import type { Credit, OrderRow, OrderState } from '../src/lib/core';
import { stateCounts } from '../src/lib/orders';
import { type Mounted, byId, mount } from './mount';

const USDC = parseCaip19(
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);
const USDC_E = parseCaip19('eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50');
const PATH_USD = parseCaip19('eip155:4217/erc20:0x20c0000000000000000000000000000000000000');

/** 2026-10-14 12:00 UTC. */
const NOW = Date.parse('2026-10-14T12:00:00Z') / 1000;
const DAY = 86_400;

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** `null`: a credit in an asset the node did not name. */
function credit(
  tx: string,
  amount: string,
  asset: typeof USDC | null = USDC,
  medium = 'solana',
  fee = '0',
): Credit {
  return { tx, amount, fee, medium, ...(asset === null || asset === undefined ? {} : { asset }) };
}

function row(
  id: string,
  createdAt: number,
  credits: Credit[],
  state: OrderState = credits.length > 0 ? 'delivered' : 'ordered',
): OrderRow {
  return {
    key: `buyer:${id}`,
    buyerPubkey: 'b'.repeat(64),
    orderId: id,
    createdAt,
    conflict: false,
    orderNotLoaded: false,
    state,
    credits,
    refunds: [],
    reported: [],
    unlistedMedium: false,
  };
}

const ROWS: OrderRow[] = [
  row('a', NOW - 60, [credit('t1', '1500000')]),
  row('b', NOW - 120, [credit('t2', '2500000')]),
  row('c', NOW - 2 * DAY, [credit('t3', '10000000')]),
  row('d', NOW - DAY, [credit('t4', '3000000', USDC_E, 'tempo')]),
  row('e', NOW - 3 * DAY, []),
  row('f', NOW - 3 * DAY, [credit('t5', '7', null, 'mystery')]),
  // The same payment named under a second order counts once, as in the totals.
  row('g', NOW - 60, [credit('t1', '1500000')]),
];

describe('the chart data', () => {
  it('buckets by UTC day and labels days', () => {
    expect(utcDay(Date.parse('2026-10-14T23:59:59Z') / 1000)).toBe('2026-10-14');
    expect(utcDay(Date.parse('2026-10-15T00:00:00Z') / 1000)).toBe('2026-10-15');
    expect(dayLabel('2026-10-04')).toBe('Oct 4');
    expect(dayLabel('2026-01-31')).toBe('Jan 31');
  });

  it('lists each credited coin once, most used first, summed in whole units, each payment once', () => {
    const coins = creditedCoins(ROWS);
    expect(coins.map((coin) => [coin.symbol, coin.network, coin.total, coin.credits])).toEqual([
      ['USDC', 'solana', '14', 3],
      ['USDC.e', 'tempo', '3', 1],
    ]);
    expect(unchartedCredits(ROWS)).toBe(1);
  });

  it('sums a coin per day over the span, ending today, and counts its orders', () => {
    const coinId = creditedCoins(ROWS)[0]?.id ?? '';
    const points = creditedByDay(ROWS, coinId, NOW, SHORT_SPAN_DAYS);
    expect(points).toHaveLength(SHORT_SPAN_DAYS);
    expect(points[0]?.day).toBe('2026-10-01');
    expect(points.at(-1)).toEqual({ day: '2026-10-14', amount: '4', orders: 2 });
    expect(points.at(-3)).toEqual({ day: '2026-10-12', amount: '10', orders: 1 });
    // The Tempo coin's credit is not in the Solana coin's days.
    expect(points.at(-2)).toEqual({ day: '2026-10-13', amount: '0', orders: 0 });
    expect(peakOf(points)).toBe('10');
    expect(sumOf(points)).toBe('14');
  });

  it('adds precisely: no float drift on cents', () => {
    const rows = [row('x', NOW, [credit('x1', '100000')]), row('y', NOW, [credit('y1', '200000')])];
    const points = creditedByDay(rows, USDC?.id ?? '', NOW, SHORT_SPAN_DAYS);
    expect(points.at(-1)?.amount).toBe('0.3');
  });

  it('spans fourteen days when every credit fits, thirty when one is older', () => {
    expect(spanDays(ROWS, NOW)).toBe(SHORT_SPAN_DAYS);
    const oldest = Date.parse('2026-10-01T00:00:00Z') / 1000;
    expect(spanDays([row('o', oldest, [credit('o1', '1')])], NOW)).toBe(SHORT_SPAN_DAYS);
    expect(spanDays([row('o', oldest - 1, [credit('o1', '1')])], NOW)).toBe(LONG_SPAN_DAYS);
    // An unpaid order or a credit without an asset does not widen the chart.
    expect(spanDays([row('o', oldest - DAY, [])], NOW)).toBe(SHORT_SPAN_DAYS);
    expect(spanDays([row('o', oldest - DAY, [credit('o1', '1', null)])], NOW)).toBe(
      SHORT_SPAN_DAYS,
    );
  });

  it('scales a bar by the peak, between 0 and 1, and 0 on an empty chart', () => {
    expect(ratioOf('5', '10')).toBe(0.5);
    expect(ratioOf('10', '10')).toBe(1);
    expect(ratioOf('0', '10')).toBe(0);
    expect(ratioOf('3', '0')).toBe(0);
    expect(ratioOf('20', '10')).toBe(1);
  });

  it('splits the orders by their first credited coin, then unknown, then unpaid', () => {
    const slices = orderSlices(ROWS, creditedCoins(ROWS));
    expect(slices.map((slice) => [slice.label, slice.count, slice.series])).toEqual([
      ['USDC on Solana', 4, 0],
      ['USDC.e on Tempo', 1, 1],
      ['Asset unknown', 1, undefined],
      ['No payment credited', 1, undefined],
    ]);
    expect(orderSlices([], [])).toEqual([]);
  });

  it('lists only the states with orders, in the filters order', () => {
    expect(statusParts(stateCounts(ROWS))).toEqual([
      { state: 'delivered', count: 6 },
      { state: 'ordered', count: 1 },
    ]);
  });
});

describe('the chart data, net of the protocol fee', () => {
  it('charts what reached the wallet: the amount less its fee, a fee too large not subtracted', () => {
    const rows = [
      row('n1', NOW, [credit('f1', '10000000', USDC, 'solana', '100000')]),
      row('n2', NOW, [credit('f2', '5000', USDC, 'solana', '9000')]),
      // A fee equal to the amount leaves nothing.
      row('n3', NOW, [credit('f3', '7000', USDC, 'solana', '7000')]),
    ];
    const coinId = USDC?.id ?? '';
    expect(creditedByDay(rows, coinId, NOW, SHORT_SPAN_DAYS).at(-1)?.amount).toBe('9.905');
    expect(creditedCoins(rows)[0]?.total).toBe('9.905');
  });

  it('sums the days of each coin to the totals card of the same rows', () => {
    const rows = [
      row('p1', NOW - 20 * DAY, [credit('g1', '19000000', USDC, 'solana', '190000')]),
      row('p2', NOW - 3 * DAY, [credit('g2', '4500000', USDC, 'solana', '45000')]),
      row('p3', NOW - DAY, [credit('g3', '12000000', USDC_E, 'tempo', '120000')]),
      row('p4', NOW, [credit('g4', '9000000', PATH_USD, 'tempo', '90000')]),
      row('p5', NOW, [credit('g5', '1', USDC, 'solana', '0')]),
    ];
    const span = spanDays(rows, NOW);
    expect(span).toBe(LONG_SPAN_DAYS);
    const totals = totalsOf(rows);
    for (const coin of creditedCoins(rows)) {
      const card = totals.perAsset.find((total) => total.asset.id === coin.id);
      expect(sumOf(creditedByDay(rows, coin.id, NOW, span)), coin.symbol).toBe(card?.amount);
      expect(coin.total).toBe(card?.amount);
    }
  });
});

describe('the chart data, one order with several payments', () => {
  it('counts an order once on its day, however many payments it holds', () => {
    const rows = [row('m', NOW, [credit('m1', '1000000'), credit('m2', '2000000')])];
    expect(creditedByDay(rows, USDC?.id ?? '', NOW, SHORT_SPAN_DAYS).at(-1)).toEqual({
      day: '2026-10-14',
      amount: '3',
      orders: 1,
    });
  });

  it('files an order paid in two coins under the first one credited', () => {
    const rows = [row('m', NOW, [credit('m1', '1000000', USDC_E, 'tempo'), credit('m2', '1')])];
    const slices = orderSlices(rows, creditedCoins(rows));
    expect(slices.map((slice) => [slice.label, slice.count])).toEqual([['USDC.e on Tempo', 1]]);
  });
});

describe('the credited chart', () => {
  it('keeps a tiny day visible next to a large peak', async () => {
    const rows = [
      row('big', NOW, [credit('b1', '1000000000')]),
      row('tiny', NOW - DAY, [credit('t1', '10000')]),
    ];
    mounted = await mount(
      <CreditedChart rows={rows} coins={creditedCoins(rows)} nowSeconds={NOW} />,
    );
    const heights = [...mounted.container.querySelectorAll('.chart-bar')].map((bar) =>
      Number(bar.getAttribute('height')),
    );
    expect(heights).toEqual([2, 100]);
  });

  it('draws one focusable day per day and a bar for each day with a credit', async () => {
    const coins = creditedCoins(ROWS);
    mounted = await mount(<CreditedChart rows={ROWS} coins={coins} nowSeconds={NOW} />);
    const days = mounted.container.querySelectorAll('.chart-day');
    expect(days).toHaveLength(SHORT_SPAN_DAYS);
    expect([...days].every((day) => day.getAttribute('tabindex') === '0')).toBe(true);
    expect(mounted.container.querySelectorAll('.chart-bar')).toHaveLength(2);
    expect(mounted.container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'USDC credited by order date',
    );
    expect(byId(mounted.container, 'credited-readout').textContent).toBe(
      '14 USDC credited on orders placed in the last 14 days',
    );
    const last = days[days.length - 1];
    await act(async () => {
      last?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(byId(mounted.container, 'credited-readout').textContent).toBe(
      'Placed Oct 14: 4 USDC credited, 2 orders',
    );
    expect(last?.getAttribute('aria-label')).toBe('Placed Oct 14: 4 USDC credited, 2 orders');
    await act(async () => {
      last?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(byId(mounted.container, 'credited-readout').textContent).toContain('last 14 days');
  });

  it('draws the peak day full height and a small day at least visible', async () => {
    const coins = creditedCoins(ROWS);
    mounted = await mount(<CreditedChart rows={ROWS} coins={coins} nowSeconds={NOW} />);
    const heights = [...mounted.container.querySelectorAll('.chart-bar')].map((bar) =>
      Number(bar.getAttribute('height')),
    );
    expect(heights).toEqual([100, 40]);
  });

  it('switches coin with its own button, never adding coins together', async () => {
    const coins = creditedCoins(ROWS);
    mounted = await mount(<CreditedChart rows={ROWS} coins={coins} nowSeconds={NOW} />);
    const buttons = [...mounted.container.querySelectorAll('button[aria-pressed]')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'USDC · Solana',
      'USDC.e · Tempo',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      (buttons[1] as HTMLButtonElement | undefined)?.click();
    });
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(byId(mounted.container, 'credited-readout').textContent).toBe(
      '3 USDC.e credited on orders placed in the last 14 days',
    );
    expect(mounted.container.querySelectorAll('.chart-bar')).toHaveLength(1);
    expect(mounted.container.querySelector('.chart-bar')?.getAttribute('class')).toContain(
      'fill-chart-2',
    );
  });

  it('shows no coin switch for one coin, and a friendly note when nothing is credited', async () => {
    const one = [row('a', NOW, [credit('t1', '1000000')])];
    mounted = await mount(<CreditedChart rows={one} coins={creditedCoins(one)} nowSeconds={NOW} />);
    expect(mounted.container.querySelector('button[aria-pressed]')).toBeNull();
    await mounted.rerender(<CreditedChart rows={[]} coins={[]} nowSeconds={NOW} />);
    expect(byId(mounted.container, 'credited-empty').textContent).toContain('Nothing credited yet');
    expect(mounted.container.querySelector('svg.chart-bars')).toBeNull();
  });
});

describe('the credited chart, more', () => {
  it('names the order date in its caption and says when the empty chart fills', async () => {
    const coins = creditedCoins(ROWS);
    mounted = await mount(<CreditedChart rows={ROWS} coins={coins} nowSeconds={NOW} />);
    expect(mounted.container.querySelector('h3')?.textContent).toBe('Credited by order date');
    expect(mounted.container.querySelector('h3 + p')?.textContent).toBe(
      'Per order date, UTC. USDC on Solana.',
    );
    expect(byId(mounted.container, 'credited-readout').getAttribute('aria-live')).toBe('polite');
    await mounted.rerender(<CreditedChart rows={[]} coins={[]} nowSeconds={NOW} />);
    expect(mounted.container.querySelector('h3')?.textContent).toBe('Credited by order date');
    expect(byId(mounted.container, 'credited-empty').textContent).toContain(
      'Your first paid order shows up here once your node confirms it on chain and you refresh.',
    );
  });

  it('says thirty days when an older order is charted', async () => {
    const rows = [...ROWS, row('old', NOW - 20 * DAY, [credit('o1', '1000000')])];
    mounted = await mount(
      <CreditedChart rows={rows} coins={creditedCoins(rows)} nowSeconds={NOW} />,
    );
    expect(mounted.container.querySelectorAll('.chart-day')).toHaveLength(LONG_SPAN_DAYS);
    expect(byId(mounted.container, 'credited-readout').textContent).toBe(
      '15 USDC credited on orders placed in the last 30 days',
    );
  });

  it('forgets a focused day when the coin changes', async () => {
    const coins = creditedCoins(ROWS);
    mounted = await mount(<CreditedChart rows={ROWS} coins={coins} nowSeconds={NOW} />);
    const days = mounted.container.querySelectorAll('.chart-day');
    await act(async () => {
      days[days.length - 1]?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(byId(mounted.container, 'credited-readout').textContent).toContain('Placed Oct 14');
    const other = [...mounted.container.querySelectorAll('button[aria-pressed]')][1];
    await act(async () => {
      (other as HTMLButtonElement | undefined)?.click();
    });
    expect(byId(mounted.container, 'credited-readout').textContent).toBe(
      '3 USDC.e credited on orders placed in the last 14 days',
    );
  });

  it('colors each coin alike in the ring, its legend and the coin switch', async () => {
    mounted = await mount(<Charts rows={ROWS} nowSeconds={NOW} />);
    const switchDots = [...mounted.container.querySelectorAll('button[aria-pressed] span')].map(
      (dot) => dot.getAttribute('class') ?? '',
    );
    const legendDots = [
      ...byId(mounted.container, 'donut-legend').querySelectorAll('li > span:first-child'),
    ].map((dot) => dot.getAttribute('class') ?? '');
    const arcs = [...mounted.container.querySelectorAll('.chart-arc')].map(
      (arc) => arc.getAttribute('class') ?? '',
    );
    ['chart-1', 'chart-2'].forEach((color, index) => {
      expect(switchDots[index]).toContain(`bg-${color}`);
      expect(legendDots[index]).toContain(`bg-${color}`);
      expect(arcs[index]).toContain(`stroke-${color}`);
    });
  });
});

describe('the orders ring and the status bar', () => {
  it('draws one order kind as a whole ring', async () => {
    mounted = await mount(
      <OrdersDonut slices={[{ key: 'unpaid', label: 'No payment credited', count: 3 }]} />,
    );
    const arcs = [...mounted.container.querySelectorAll('.chart-arc')];
    expect(arcs).toHaveLength(1);
    expect(arcs[0]?.getAttribute('stroke-dasharray')).toBe('100 0');
    expect(arcs[0]?.getAttribute('stroke-dashoffset')).toBe('0');
  });

  it('draws an arc per slice, with the total in the middle and a legend', async () => {
    const slices = orderSlices(ROWS, creditedCoins(ROWS));
    mounted = await mount(<OrdersDonut slices={slices} />);
    const arcs = [...mounted.container.querySelectorAll('.chart-arc')];
    expect(arcs).toHaveLength(4);
    expect(arcs[0]?.getAttribute('class')).toContain('stroke-chart-1');
    expect(arcs[2]?.getAttribute('class')).toContain('stroke-warn');
    expect(arcs[1]?.getAttribute('class')).toContain('stroke-chart-2');
    expect(arcs[3]?.getAttribute('class')).toContain('stroke-chart-idle');
    expect(mounted.container.querySelector('svg text')?.textContent).toBe('7');
    expect(byId(mounted.container, 'donut-legend').textContent).toContain('USDC on Solana457%');
    expect(mounted.container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      '7 orders loaded: 4 USDC on Solana, 1 USDC.e on Tempo, 1 Asset unknown, 1 No payment credited',
    );
    await mounted.rerender(<OrdersDonut slices={[]} />);
    expect(byId(mounted.container, 'donut-empty').textContent).toBe('No orders yet.');
  });

  it('splits one bar by state with a legend', async () => {
    mounted = await mount(<StatusStrip parts={statusParts(stateCounts(ROWS))} />);
    const segments = [...mounted.container.querySelectorAll('.chart-segment')];
    expect(segments.map((segment) => Number(segment.getAttribute('width')).toFixed(2))).toEqual([
      '85.71',
      '14.29',
    ]);
    expect(segments[1]?.getAttribute('x')).toBe(segments[0]?.getAttribute('width'));
    expect(byId(mounted.container, 'status-legend').textContent).toBe('Completed6Ordered1');
    const dots = [
      ...byId(mounted.container, 'status-legend').querySelectorAll('li > span:first-child'),
    ];
    expect(dots.map((dot) => dot.getAttribute('class'))).toEqual([
      'size-8 rounded-full bg-green',
      'size-8 rounded-full bg-chart-idle',
    ]);
    await mounted.rerender(<StatusStrip parts={[]} />);
    expect(byId(mounted.container, 'status-empty').textContent).toBe('No orders yet.');
  });

  it('says how many credits it cannot chart', async () => {
    mounted = await mount(<Charts rows={ROWS} nowSeconds={NOW} />);
    expect(byId(mounted.container, 'uncharted').textContent).toBe(
      '1 payment in an asset your node did not name is in the totals, not in the chart.',
    );
    await mounted.rerender(<Charts rows={ROWS.slice(0, 2)} nowSeconds={NOW} />);
    expect(mounted.container.querySelector('#uncharted')).toBeNull();
  });
});

describe('the chart motion', () => {
  const css = readFileSync(`${process.cwd()}/src/app.css`, 'utf8');

  it('animates bars, arcs and the status bar, and none of them under reduced motion', () => {
    for (const name of ['.chart-bar', '.chart-arc', '.chart-strip']) {
      expect(css).toMatch(new RegExp(`\\${name} \\{[^}]*animation: chart-`));
    }
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const name of ['.chart-bar', '.chart-arc', '.chart-strip']) {
      expect(reduced).toContain(name);
    }
    expect(reduced).toMatch(/animation: none/);
  });
});

describe('the overview', () => {
  it('shows the charts under the totals', async () => {
    mounted = await mount(
      <Overview
        snapshot={{
          storePubkey: 'a'.repeat(64),
          store: { name: 'Shop', relays: [], noInboxList: false, payoutMediums: [] },
          history: { rows: ROWS, totals: { perAsset: [], unknownAsset: [] } },
          products: [],
          warnings: [],
          more: false,
        }}
        onTab={() => undefined}
      />,
    );
    const totals = byId(mounted.container, 'totals');
    const charts = byId(mounted.container, 'charts');
    expect(totals.compareDocumentPosition(charts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(charts.querySelectorAll('.chart-arc')).toHaveLength(4);
  });

  it('keeps the bars at the height of their card, not of their own aspect ratio', async () => {
    mounted = await mount(<Charts rows={ROWS} nowSeconds={NOW} />);
    const bars = mounted.container.querySelector('svg.chart-bars');
    const classes = (element: Element | null | undefined) =>
      (element?.getAttribute('class') ?? '').split(/\s+/);
    expect(classes(bars)).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'size-full']));
    expect(classes(bars?.parentElement)).toEqual(
      expect.arrayContaining(['relative', 'flex-1', 'min-h-160']),
    );
  });

  it('lays the recent orders full width with the store links in a row under them', async () => {
    mounted = await mount(
      <Overview
        snapshot={{
          storePubkey: 'a'.repeat(64),
          store: { name: 'Shop', relays: [], noInboxList: false, payoutMediums: [] },
          history: { rows: ROWS, totals: { perAsset: [], unknownAsset: [] } },
          products: [],
          warnings: [],
          more: false,
        }}
        onTab={() => undefined}
      />,
    );
    const page = mounted.container.firstElementChild;
    const recent = [...(page?.children ?? [])].find((child) =>
      child.textContent?.startsWith('Recent orders'),
    );
    const links = recent?.nextElementSibling;
    expect(recent?.parentElement).toBe(page);
    expect(links?.className.split(' ')).toEqual(['grid', 'gap-12', 'sm:grid-cols-2']);
    expect(links?.querySelectorAll(':scope > button')).toHaveLength(2);
    expect(links?.nextElementSibling).toBeNull();
  });
});

describe('the totals', () => {
  it('shows one credited card per coin and no order counts', async () => {
    const coins = [USDC, USDC_E, PATH_USD].flatMap((coin) => (coin === undefined ? [] : [coin]));
    mounted = await mount(
      <Totals
        history={{
          rows: ROWS,
          totals: {
            perAsset: coins.map((asset) => ({ asset, subunits: '44500000', amount: '44.5' })),
            unknownAsset: [],
          },
        }}
      />,
    );
    const cards = [...byId(mounted.container, 'totals').children];
    expect(cards.map((card) => card.querySelector('p')?.textContent)).toEqual([
      'USDC credited',
      'USDC.e credited',
      'pathUSD credited',
    ]);
    const text = byId(mounted.container, 'totals').textContent ?? '';
    for (const gone of ['Orders loaded', 'Completed', 'Payment reported', 'nothing credited yet']) {
      expect(text).not.toContain(gone);
    }
  });
});

describe('the chart marks take their colors from the maps', () => {
  it('colors each status segment and legend dot by its state, every state drawn', async () => {
    const parts = statusParts(
      stateCounts([
        ...ROWS,
        row('r1', NOW, [], 'released'),
        row('r2', NOW, [], 'refunded'),
        row('r3', NOW, [], 'payment_reported'),
      ]),
    );
    expect(parts.map((part) => part.state)).toEqual([
      'delivered',
      'payment_reported',
      'ordered',
      'refunded',
      'released',
    ]);
    mounted = await mount(<StatusStrip parts={parts} />);
    const segments = [...mounted.container.querySelectorAll('.chart-segment')];
    const dots = [
      ...byId(mounted.container, 'status-legend').querySelectorAll('li > span:first-child'),
    ];
    parts.forEach((part, index) => {
      expect(segments[index]?.getAttribute('class')).toBe(
        `chart-segment ${STATE_FILLS[part.state]}`,
      );
      expect(dots[index]?.getAttribute('class')).toBe(
        `size-8 rounded-full ${STATE_DOTS[part.state]}`,
      );
    });
  });

  it('colors the unknown and unpaid slices and their dots from the maps', async () => {
    mounted = await mount(<OrdersDonut slices={orderSlices(ROWS, creditedCoins(ROWS))} />);
    const arcs = [...mounted.container.querySelectorAll('.chart-arc')];
    const dots = [
      ...byId(mounted.container, 'donut-legend').querySelectorAll('li > span:first-child'),
    ];
    for (const [index, key] of [
      [2, 'unknown'],
      [3, 'unpaid'],
    ] as const) {
      expect(arcs[index]?.getAttribute('class')).toContain(OTHER_STROKES[key] ?? 'missing');
      expect(dots[index]?.getAttribute('class')).toContain(OTHER_DOTS[key] ?? 'missing');
    }
  });
});
