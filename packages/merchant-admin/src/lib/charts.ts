import Decimal from 'decimal.js-light';
import type { Credit, OrderRow, OrderState } from './core';
import { STATE_ORDER } from './orders';

/** Plain notation and room for sums of many 39-digit subunit counts, as the totals use. */
const ChartDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 100 });

type Coin = NonNullable<Credit['asset']>;

const SECONDS_PER_DAY = 86_400;

/** The chart spans two weeks when every credit fits in them, else thirty days. */
export const SHORT_SPAN_DAYS = 14;
export const LONG_SPAN_DAYS = 30;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The fill class of each series, in the order the coins are listed; the last one repeats. */
export const SERIES_FILLS = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4'];
export const SERIES_STROKES = [
  'stroke-chart-1',
  'stroke-chart-2',
  'stroke-chart-3',
  'stroke-chart-4',
];
export const SERIES_DOTS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4'];

/** A coin the node credited, on its network. */
export interface CoinSeries {
  /** The CAIP-19 id. */
  id: string;
  symbol: string;
  /** The chain's slug: `solana`, `tempo`. */
  network: string;
  /** Whole units credited over all loaded orders. */
  total: string;
  /** Payments credited in it. */
  credits: number;
}

/** One UTC day of one coin. */
export interface DayPoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Whole units credited that day. */
  amount: string;
  /** Orders with a credit in this coin that day. */
  orders: number;
}

/** A part of the orders: one coin, a credit in an unknown asset, or none yet. */
export interface OrderSlice {
  key: string;
  label: string;
  count: number;
  /** The index of its coin in `creditedCoins`, for its color; absent for the others. */
  series?: number;
}

/** Each credited payment once (as the totals count them), with the order it belongs to. */
function uniqueCredits(rows: readonly OrderRow[]): { row: OrderRow; credit: Credit }[] {
  const seen = new Set<string>();
  const found: { row: OrderRow; credit: Credit }[] = [];
  for (const row of rows) {
    for (const credit of row.credits) {
      const id = `${credit.medium}|${credit.tx}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      found.push({ row, credit });
    }
  }
  return found;
}

function wholeOf(subunits: string, coin: Coin): Decimal {
  return new ChartDecimal(subunits).div(new ChartDecimal(10).pow(coin.asset.decimals));
}

/** The UTC day of a date in seconds, as `YYYY-MM-DD`. */
export function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` as `Oct 12`. */
export function dayLabel(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7);
  return `${month} ${Number(day.slice(8, 10))}`;
}

/** The coins the node credited, the most used first, then by symbol and network. */
export function creditedCoins(rows: readonly OrderRow[]): CoinSeries[] {
  const byId = new Map<string, { coin: Coin; sum: Decimal; credits: number }>();
  for (const { credit } of uniqueCredits(rows)) {
    const coin = credit.asset;
    if (coin === undefined) {
      continue;
    }
    const entry = byId.get(coin.id);
    const amount = wholeOf(credit.amount, coin);
    if (entry === undefined) {
      byId.set(coin.id, { coin, sum: amount, credits: 1 });
    } else {
      entry.sum = entry.sum.plus(amount);
      entry.credits += 1;
    }
  }
  return [...byId.values()]
    .map(({ coin, sum, credits }) => ({
      id: coin.id,
      symbol: coin.asset.symbol,
      network: coin.chain.slug,
      total: sum.toString(),
      credits,
    }))
    .sort(
      (first, second) =>
        second.credits - first.credits ||
        first.symbol.localeCompare(second.symbol) ||
        first.network.localeCompare(second.network),
    );
}

/** Credited payments whose asset the node did not name: counted in the totals, not charted. */
export function unchartedCredits(rows: readonly OrderRow[]): number {
  return uniqueCredits(rows).filter(({ credit }) => credit.asset === undefined).length;
}

/** Fourteen days when every credit of the loaded orders is that recent, else thirty. */
export function spanDays(rows: readonly OrderRow[], nowSeconds: number): number {
  const today = Date.parse(`${utcDay(nowSeconds)}T00:00:00Z`) / 1000;
  const oldest = today - (SHORT_SPAN_DAYS - 1) * SECONDS_PER_DAY;
  const older = uniqueCredits(rows).some(
    ({ row, credit }) => credit.asset !== undefined && row.createdAt < oldest,
  );
  return older ? LONG_SPAN_DAYS : SHORT_SPAN_DAYS;
}

/** The last `span` UTC days up to today, each with what `coinId` credited and in how many orders. */
export function creditedByDay(
  rows: readonly OrderRow[],
  coinId: string,
  nowSeconds: number,
  span: number,
): DayPoint[] {
  const today = Date.parse(`${utcDay(nowSeconds)}T00:00:00Z`) / 1000;
  const days = Array.from({ length: span }, (_, index) =>
    utcDay(today - (span - 1 - index) * SECONDS_PER_DAY),
  );
  const sums = new Map<string, Decimal>(days.map((day) => [day, new ChartDecimal(0)]));
  const orders = new Map<string, Set<string>>(days.map((day) => [day, new Set<string>()]));
  for (const { row, credit } of uniqueCredits(rows)) {
    const coin = credit.asset;
    const day = utcDay(row.createdAt);
    const sum = sums.get(day);
    if (coin === undefined || coin.id !== coinId || sum === undefined) {
      continue;
    }
    sums.set(day, sum.plus(wholeOf(credit.amount, coin)));
    orders.get(day)?.add(row.key);
  }
  return days.map((day) => ({
    day,
    amount: (sums.get(day) ?? new ChartDecimal(0)).toString(),
    orders: orders.get(day)?.size ?? 0,
  }));
}

/** The largest day, the top of the scale. */
export function peakOf(points: readonly DayPoint[]): string {
  return points
    .reduce((peak, point) => {
      const amount = new ChartDecimal(point.amount);
      return amount.gt(peak) ? amount : peak;
    }, new ChartDecimal(0))
    .toString();
}

/** `amount / peak`, between 0 and 1, for a bar's height: 0 when the peak is 0. */
export function ratioOf(amount: string, peak: string): number {
  const top = new ChartDecimal(peak);
  if (top.lte(0)) {
    return 0;
  }
  const ratio = new ChartDecimal(amount).div(top);
  if (ratio.lte(0)) {
    return 0;
  }
  return ratio.gte(1) ? 1 : ratio.toNumber();
}

/** Whole units summed over the days, for the chart's caption. */
export function sumOf(points: readonly DayPoint[]): string {
  return points
    .reduce((sum, point) => sum.plus(new ChartDecimal(point.amount)), new ChartDecimal(0))
    .toString();
}

/**
 * The loaded orders by how they were paid: per coin (the first coin credited
 * to the order), a credit in an asset the node did not name, or no credit yet.
 */
export function orderSlices(rows: readonly OrderRow[], coins: readonly CoinSeries[]): OrderSlice[] {
  const perCoin = new Map<string, number>();
  let unknown = 0;
  let unpaid = 0;
  for (const row of rows) {
    const first = row.credits[0];
    if (first === undefined) {
      unpaid += 1;
    } else if (first.asset === undefined) {
      unknown += 1;
    } else {
      perCoin.set(first.asset.id, (perCoin.get(first.asset.id) ?? 0) + 1);
    }
  }
  const slices: OrderSlice[] = coins.flatMap((coin, series) => {
    const count = perCoin.get(coin.id) ?? 0;
    return count === 0
      ? []
      : [{ key: coin.id, label: `${coin.symbol} on ${networkName(coin.network)}`, count, series }];
  });
  if (unknown > 0) {
    slices.push({ key: 'unknown', label: 'Asset unknown', count: unknown });
  }
  if (unpaid > 0) {
    slices.push({ key: 'unpaid', label: 'No payment credited', count: unpaid });
  }
  return slices;
}

/** A chain slug as a name: `solana` is Solana. */
export function networkName(slug: string): string {
  return slug.length === 0 ? slug : `${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
}

/** The order states with at least one order, in the filters' order. */
export function statusParts(
  counts: Readonly<Record<OrderState, number>>,
): { state: OrderState; count: number }[] {
  return STATE_ORDER.filter((state) => counts[state] > 0).map((state) => ({
    state,
    count: counts[state],
  }));
}

/** The share of `count` in `total`, between 0 and 1: 0 when there is nothing. */
export function shareOf(count: number, total: number): number {
  return total <= 0 ? 0 : Math.min(Math.max(count / total, 0), 1);
}

/** A series index's class from a palette, the last one for any past its end. */
export function seriesClass(palette: readonly string[], series: number): string {
  return palette[Math.min(series, palette.length - 1)] ?? '';
}
