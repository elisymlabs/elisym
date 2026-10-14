import { useState } from 'react';
import {
  type CoinSeries,
  SERIES_DOTS,
  SERIES_FILLS,
  creditedByDay,
  dayLabel,
  networkName,
  peakOf,
  seriesClass,
  spanDays,
  sumOf,
} from '../lib/charts';
import type { OrderRow } from '../lib/core';
import { ChartCard } from './ChartCard';
import { DayBars } from './DayBars';
import { Icon } from './Icon';

interface Props {
  rows: readonly OrderRow[];
  coins: readonly CoinSeries[];
  nowSeconds: number;
}

/**
 * What the node credited, by the date each order was placed (the order's own date,
 * UTC), one coin at a time: coins are never added together.
 */
export function CreditedChart({ rows, coins, nowSeconds }: Props) {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [active, setActive] = useState<number | undefined>(undefined);
  const series = Math.max(
    coins.findIndex((coin) => coin.id === chosen),
    0,
  );
  const coin = coins[series];
  if (coin === undefined) {
    return (
      <ChartCard title="Credited by order date">
        <div id="credited-empty" className="flex flex-col items-center gap-8 py-40 text-center">
          <span className="bg-accent-soft text-accent-ink rounded-12 grid size-40 place-items-center">
            <Icon name="receipt" className="size-20" />
          </span>
          <p className="text-15 font-medium">Nothing credited yet</p>
          <p className="text-13 text-text-2 max-w-320">
            Your first paid order shows up here once your node confirms it on chain and you refresh.
          </p>
        </div>
      </ChartCard>
    );
  }
  const span = spanDays(rows, nowSeconds);
  const points = creditedByDay(rows, coin.id, nowSeconds, span);
  const peak = peakOf(points);
  const point = active === undefined ? undefined : points[active];
  const first = points[0];
  const last = points[points.length - 1];
  let readout = `${sumOf(points)} ${coin.symbol} credited on orders placed in the last ${span} days`;
  if (point !== undefined) {
    readout = `Placed ${dayLabel(point.day)}: ${point.amount} ${coin.symbol} credited, ${point.orders} ${point.orders === 1 ? 'order' : 'orders'}`;
  }
  return (
    <ChartCard
      title="Credited by order date"
      className="flex-1"
      caption={`Per order date, UTC. ${coin.symbol} on ${networkName(coin.network)}.`}
      actions={
        coins.length > 1 && (
          <div
            role="group"
            aria-label="Coin"
            className="bg-surface-2 rounded-10 flex flex-wrap gap-2 p-2"
          >
            {coins.map((option, index) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.id === coin.id}
                onClick={() => {
                  setChosen(option.id);
                  setActive(undefined);
                }}
                className={`rounded-8 text-13 flex items-center gap-6 px-10 py-4 font-medium ${
                  option.id === coin.id
                    ? 'bg-surface text-text shadow-sm'
                    : 'text-text-2 hover:text-text'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`size-8 rounded-full ${seriesClass(SERIES_DOTS, index)}`}
                />
                {`${option.symbol} · ${networkName(option.network)}`}
              </button>
            ))}
          </div>
        )
      }
    >
      <p id="credited-readout" aria-live="polite" className="text-14 text-text-2 min-h-20">
        {readout}
      </p>
      <div className="flex flex-1 flex-col gap-8">
        <div className="border-line relative min-h-160 flex-1 border-b">
          <DayBars
            key={coin.id}
            points={points}
            peak={peak}
            symbol={coin.symbol}
            fill={seriesClass(SERIES_FILLS, series)}
            active={active}
            onActive={setActive}
          />
        </div>
        <div className="text-12 text-text-3 flex justify-between">
          <span>{first === undefined ? '' : dayLabel(first.day)}</span>
          <span>{`peak ${peak} ${coin.symbol}`}</span>
          <span>{last === undefined ? '' : dayLabel(last.day)}</span>
        </div>
      </div>
    </ChartCard>
  );
}
