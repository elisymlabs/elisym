import { connectorResultSentence } from '../lib/connector';
import type { ConnectorSyncResult } from '../lib/types';
import { DiffSummary } from './DiffSummary';

interface Props {
  result: ConnectorSyncResult;
}

const MAX_SHOWN = 20;

/** The first import's preview: what a sync would publish, nothing published yet (7.4). */
export function PreviewResult({ result }: Props) {
  if (result.status !== 'ok') {
    return <p className="text-14 text-error">{connectorResultSentence(result)}</p>;
  }
  const items = result.items ?? [];
  return (
    <div className="text-14 flex flex-col gap-12">
      <DiffSummary diff={result.diff} />
      {items.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {items.slice(0, MAX_SHOWN).map((item) => (
            <li key={item.d} className="flex justify-between gap-12">
              <span className="truncate">{item.title}</span>
              <span className="whitespace-nowrap">
                {item.price.amount} {item.price.currency}
              </span>
            </li>
          ))}
          {items.length > MAX_SHOWN ? (
            <li className="text-text-2">and {items.length - MAX_SHOWN} more</li>
          ) : null}
        </ul>
      )}
      {result.truncated.length === 0 ? null : (
        <p className="text-text-2">
          {result.truncated.length} product{result.truncated.length === 1 ? ' was' : 's were'}{' '}
          shortened to fit the listing limits.
        </p>
      )}
      {result.skipped.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-text-2">{result.skipped.length} skipped:</p>
          <ul className="text-13 text-text-2">
            {result.skipped.slice(0, MAX_SHOWN).map((skipped) => (
              <li key={skipped.sourceId}>
                {skipped.sourceId}: {skipped.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.policyError === undefined ? null : (
        <p className="text-warn">Policies were not imported: {result.policyError}</p>
      )}
    </div>
  );
}
