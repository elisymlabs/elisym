import type { History } from '../lib/core';
import { Stat } from './Stat';

interface Props {
  history: History;
}

/**
 * What the node credited, per coin: the history's own totals, no arithmetic here.
 * One to three coins stretch across the row; the order counts are in the charts.
 */
export function Totals({ history }: Props) {
  const { perAsset, unknownAsset } = history.totals;
  const empty = perAsset.length === 0 && unknownAsset.length === 0;
  return (
    <div
      id="totals"
      className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]"
    >
      {perAsset.map((total) => (
        <Stat
          key={total.asset.id}
          label={`${total.asset.asset.symbol} credited`}
          value={`${total.amount} ${total.asset.asset.symbol}`}
          hint={total.asset.chain.slug}
          title={total.asset.id}
          tone="accent"
        />
      ))}
      {unknownAsset.map((raw) => (
        <Stat
          key={raw.medium}
          label={`asset unknown (${raw.medium})`}
          value={`${raw.subunits} subunits`}
          tone="accent"
        />
      ))}
      {empty && <Stat label="Credited" value="nothing credited yet" hint="by your node" />}
    </div>
  );
}
