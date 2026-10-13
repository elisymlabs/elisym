import type { History } from '../lib/core';
import { Section } from './Section';

interface Props {
  history: History;
}

/** What the node credited, per coin: the history's own totals, no arithmetic here. */
export function Totals({ history }: Props) {
  const { perAsset, unknownAsset } = history.totals;
  const empty = perAsset.length === 0 && unknownAsset.length === 0;
  return (
    <Section title="Credited by your node">
      <div id="totals" className="grid grid-cols-1 gap-12 sm:grid-cols-3">
        <Stat label="Orders loaded" value={String(history.rows.length)} />
        {perAsset.map((total) => (
          <Stat
            key={total.asset.id}
            label={total.asset.id}
            value={`${total.amount} ${total.asset.asset.symbol}`}
          />
        ))}
        {unknownAsset.map((raw) => (
          <Stat
            key={raw.medium}
            label={`asset unknown (${raw.medium})`}
            value={`${raw.subunits} subunits`}
          />
        ))}
        {empty && <Stat label="Credited" value="nothing credited yet" />}
      </div>
    </Section>
  );
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps) {
  return (
    <div className="rounded-12 border-line bg-surface min-w-0 border p-14">
      <p className="text-12 text-text-2 truncate" title={label}>
        {label}
      </p>
      <p className="text-20 mt-4 font-semibold">{value}</p>
    </div>
  );
}
