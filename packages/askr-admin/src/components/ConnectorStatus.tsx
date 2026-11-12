import { connectorResultSentence } from '../lib/connector';
import { PLATFORM_LABELS } from '../lib/labels';
import type { ConnectorRecord } from '../lib/types';

interface Props {
  connector: ConnectorRecord | null;
}

function timeOf(ms: number | null): string {
  return ms === null ? 'not yet' : new Date(ms).toLocaleString();
}

export function ConnectorStatus({ connector }: Props) {
  if (connector === null) {
    return <p className="text-14 text-text-2">No connector is set up.</p>;
  }
  return (
    <dl className="text-14 grid grid-cols-[auto_1fr] gap-x-16 gap-y-4">
      <dt className="text-text-2">Platform</dt>
      <dd>{PLATFORM_LABELS[connector.platform]}</dd>
      <dt className="text-text-2">Address</dt>
      <dd className="break-all">{connector.url}</dd>
      <dt className="text-text-2">Syncing</dt>
      <dd>{connector.enabled ? 'On' : 'Off (preview it, then turn it on)'}</dd>
      <dt className="text-text-2">Last run</dt>
      <dd>{timeOf(connector.lastRunAt)}</dd>
      <dt className="text-text-2">Next run</dt>
      <dd>{timeOf(connector.nextRunAt)}</dd>
      <dt className="text-text-2">Last result</dt>
      <dd>{connectorResultSentence(connector.lastStatus)}</dd>
    </dl>
  );
}
