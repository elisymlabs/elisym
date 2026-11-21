import { connectorResultSentence } from '../lib/connector';
import { PLATFORM_LABELS } from '../lib/labels';
import type { ConnectorRecord, Tier } from '../lib/types';

interface Props {
  connector: ConnectorRecord | null;
  /** The store's plan: how often it syncs and how many products it holds. */
  tier?: Tier | null;
}

function timeOf(ms: number | null): string {
  return ms === null ? 'not yet' : new Date(ms).toLocaleString();
}

export function ConnectorStatus({ connector, tier }: Props) {
  if (connector === null) {
    return <p className="text-14 text-text-2">No connector is set up.</p>;
  }
  const rows: { label: string; value: string }[] = [
    { label: 'Platform', value: PLATFORM_LABELS[connector.platform] },
    { label: 'Address', value: connector.url },
    { label: 'Syncing', value: connector.enabled ? 'On' : 'Off' },
  ];
  if (tier !== undefined && tier !== null) {
    rows.push({
      label: 'Your plan',
      value: `Syncs every ${tier.syncIntervalMinutes} minute${tier.syncIntervalMinutes === 1 ? '' : 's'}, up to ${tier.maxProducts} products`,
    });
  }
  rows.push(
    { label: 'Last run', value: timeOf(connector.lastRunAt) },
    { label: 'Next run', value: timeOf(connector.nextRunAt) },
    { label: 'Last result', value: connectorResultSentence(connector.lastStatus) },
  );
  return (
    <dl className="kv">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
