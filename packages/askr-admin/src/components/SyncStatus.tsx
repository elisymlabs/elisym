import type { CatalogSyncStatus } from '../lib/types';

interface Props {
  sync: CatalogSyncStatus | null;
}

const STATES: Readonly<Record<CatalogSyncStatus['state'], string>> = {
  running: 'Publishing products...',
  done: 'Last product sync finished.',
  failed: 'Last product sync failed.',
};

/** The last catalog sync the admin started, with its counts. */
export function SyncStatus({ sync }: Props) {
  if (sync === null) {
    return <p className="text-14 text-text-2">No product sync has run yet.</p>;
  }
  const { diff } = sync;
  return (
    <div className="text-14 flex flex-col gap-4">
      <p className={sync.state === 'failed' ? 'text-error' : ''}>{STATES[sync.state]}</p>
      <p className="text-text-2">
        {diff.created.length} new, {diff.updated.length} updated, {diff.hidden.length} removed,{' '}
        {diff.unchanged.length} unchanged
      </p>
      {sync.state === 'failed' ? <p className="text-text-2">Reason: {sync.error}</p> : null}
    </div>
  );
}
