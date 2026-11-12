import type { SyncDiff } from '@elisym/askr';

interface Props {
  diff: SyncDiff;
}

const MAX_LISTED = 20;

const GROUPS: readonly { key: keyof SyncDiff; label: string }[] = [
  { key: 'created', label: 'New' },
  { key: 'updated', label: 'Updated' },
  // A sync deletes these (a hidden version and a NIP-09 deletion): they cannot be shown again.
  { key: 'hidden', label: 'Removed' },
  { key: 'unchanged', label: 'Unchanged' },
];

/** What a catalog sync would do, by product ID. */
export function DiffSummary({ diff }: Props) {
  return (
    <dl className="text-14 flex flex-col gap-8">
      {GROUPS.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <dt className="font-medium">
            {group.label}: {diff[group.key].length}
          </dt>
          {group.key === 'unchanged' || diff[group.key].length === 0 ? null : (
            <dd className="text-13 text-text-2 font-mono break-all">
              {diff[group.key].slice(0, MAX_LISTED).join(', ')}
              {diff[group.key].length > MAX_LISTED
                ? ` and ${diff[group.key].length - MAX_LISTED} more`
                : ''}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}
