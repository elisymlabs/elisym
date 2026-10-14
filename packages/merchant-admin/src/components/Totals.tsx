import type { History } from '../lib/core';
import { stateCounts } from '../lib/orders';
import { Stat } from './Stat';

interface Props {
  history: History;
}

/** What the node credited, per coin: the history's own totals, no arithmetic here. */
export function Totals({ history }: Props) {
  const { perAsset, unknownAsset } = history.totals;
  const empty = perAsset.length === 0 && unknownAsset.length === 0;
  const counts = stateCounts(history.rows);
  return (
    <div
      id="totals"
      className="grid grid-cols-2 gap-12 md:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]"
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
      <Stat label="Orders loaded" value={String(history.rows.length)} />
      <Stat label="Completed" value={String(counts.delivered)} />
      <Stat
        label="Payment reported"
        value={String(counts.payment_reported)}
        hint="not confirmed by your node"
        tone={counts.payment_reported > 0 ? 'warn' : 'plain'}
      />
    </div>
  );
}
