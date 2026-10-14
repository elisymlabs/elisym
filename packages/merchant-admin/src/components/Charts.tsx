import { creditedCoins, orderSlices, statusParts, unchartedCredits } from '../lib/charts';
import type { OrderRow } from '../lib/core';
import { stateCounts } from '../lib/orders';
import { CreditedChart } from './CreditedChart';
import { OrdersDonut } from './OrdersDonut';
import { StatusStrip } from './StatusStrip';

interface Props {
  rows: readonly OrderRow[];
  nowSeconds: number;
}

/** The overview's charts, over the loaded orders only. */
export function Charts({ rows, nowSeconds }: Props) {
  const coins = creditedCoins(rows);
  const uncharted = unchartedCredits(rows);
  return (
    <div id="charts" className="grid gap-16 lg:grid-cols-[1.6fr_1fr]">
      <div className="flex min-w-0 flex-col gap-8">
        <CreditedChart rows={rows} coins={coins} nowSeconds={nowSeconds} />
        {uncharted > 0 && (
          <p id="uncharted" className="text-12 text-text-3 px-4">
            {`${uncharted} ${uncharted === 1 ? 'payment' : 'payments'} in an asset your node did not name ${uncharted === 1 ? 'is' : 'are'} in the totals, not in the chart.`}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-16">
        <OrdersDonut slices={orderSlices(rows, coins)} />
        <StatusStrip parts={statusParts(stateCounts(rows))} />
      </div>
    </div>
  );
}
