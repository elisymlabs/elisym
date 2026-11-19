import type { CatalogSyncStatus } from '../lib/types';

interface Props {
  sync: CatalogSyncStatus | null;
}

const STATES: Readonly<Record<CatalogSyncStatus['state'], string>> = {
  running: 'Publishing products...',
  done: 'Last product sync finished.',
  failed: 'Last product sync failed.',
};

const DOTS: Readonly<Record<CatalogSyncStatus['state'], string>> = {
  running: 'bg-warn animate-pulse',
  done: 'bg-green',
  failed: 'bg-error',
};

/** The last catalog sync the admin started, with its counts. */
export function SyncStatus({ sync }: Props) {
  if (sync === null) {
    return <p className="text-14 text-text-2">No product sync has run yet.</p>;
  }
  const { diff } = sync;
  const counts = [
    { label: 'new', value: diff.created.length },
    { label: 'updated', value: diff.updated.length },
    { label: 'removed', value: diff.hidden.length },
    { label: 'unchanged', value: diff.unchanged.length },
  ];
  return (
    <div className="text-14 flex flex-col gap-12">
      <p
        className={`flex items-center gap-8 font-medium ${sync.state === 'failed' ? 'text-error' : ''}`}
      >
        <span aria-hidden="true" className={`size-7 shrink-0 rounded-full ${DOTS[sync.state]}`} />
        {STATES[sync.state]}
      </p>
      <p className="text-text-2 flex flex-wrap gap-x-20 gap-y-4">
        {counts.map((count, index) => (
          <span key={count.label}>
            <span className="text-text font-medium tabular-nums">{count.value}</span> {count.label}
            {index < counts.length - 1 ? <span className="sr-only">,</span> : null}
          </span>
        ))}
      </p>
      {sync.state === 'failed' ? <p className="text-text-2">Reason: {sync.error}</p> : null}
    </div>
  );
}
