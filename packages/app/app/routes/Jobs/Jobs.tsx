import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePageVisible } from '~/hooks/usePageVisible';
import { cn } from '~/lib/cn';
import { clearUnseen, jobHistoryVersion, readJobs, subscribeJobHistory } from '~/lib/jobHistory';
import { JobRow } from './JobRow';
import { useJobsMerge } from './useJobsMerge';

/** Rows rendered per "page" - the full merged list stays in memory, only the
 * DOM is capped so a large history cannot make the page unusable. */
const PAGE_SIZE = 50;

export default function JobsPage() {
  const { rows, wallet, merged, isFetching, isError, refetch } = useJobsMerge();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Decision 4 clear site (a): every `unseen` flag is cleared on mount and
  // kept clear while the page stays VISIBLE - keyed on (wallet, store
  // version, visibility) so a poller flip landing mid-visit, a wallet
  // switch, or a return to a background tab is covered. The visibility
  // gate matters: a background tab parked here receives the active tab's
  // writes as storage events and would otherwise clear flags nobody saw.
  // The store's no-op-write guard breaks the version self-loop. The flagged
  // ids are recorded BEFORE the clear so the "landed while you were away"
  // tint survives the visit instead of vanishing one frame after paint.
  const pageVisible = usePageVisible();
  // One flat set for the mount's lifetime: job event ids are globally unique
  // nostr event ids, so entries surviving a wallet switch cannot mis-tint
  // another wallet's rows.
  const highlightedIdsRef = useRef<Set<string>>(new Set());
  const storeVersion = useSyncExternalStore(subscribeJobHistory, jobHistoryVersion);
  useEffect(() => {
    if (!wallet || !pageVisible) {
      return;
    }
    for (const job of readJobs(wallet)) {
      if (job.unseen === true) {
        highlightedIdsRef.current.add(job.jobEventId);
      }
    }
    clearUnseen(wallet);
  }, [wallet, storeVersion, pageVisible]);

  let syncLabel = 'Synced from relays - older events may have expired.';
  if (isFetching) {
    syncLabel = 'Syncing from relays…';
  } else if (isError) {
    syncLabel = 'Relay sync failed - showing local history only.';
  } else if (!merged) {
    syncLabel = 'Showing local history.';
  }

  const visibleRows = rows.slice(0, visibleCount);
  const remaining = rows.length - visibleRows.length;

  return (
    <div id="light-content" className="pt-12 pb-48 sm:pt-16 sm:pb-64">
      <div className="mx-auto max-w-3xl px-12 sm:px-24">
        <div className="flex items-center justify-between gap-12">
          <h1 className="text-lg font-bold sm:text-xl">My Jobs</h1>
          <button
            type="button"
            onClick={refetch}
            disabled={isFetching}
            className="inline-flex h-28 btn items-center justify-center gap-6 btn-outline px-10 text-[11px]"
          >
            <svg
              aria-hidden
              className={cn('size-12', isFetching && 'animate-spin')}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            Refresh
          </button>
        </div>
        <p className="mt-4 mb-16 text-xs text-text-2">
          Jobs you submitted, across every provider. {syncLabel}
        </p>
        {rows.length > 0 ? (
          <>
            <ul className="overflow-hidden rounded-2xl border border-black/7 bg-surface">
              {visibleRows.map((row) => (
                <JobRow
                  key={row.jobEventId}
                  row={row}
                  highlighted={row.unseen || highlightedIdsRef.current.has(row.jobEventId)}
                />
              ))}
            </ul>
            {remaining > 0 && (
              <div className="mt-12 flex justify-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                  className="inline-flex h-28 btn items-center justify-center btn-outline px-12 text-[11px]"
                >
                  Show more ({remaining})
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-8 rounded-2xl border border-black/7 bg-surface px-16 py-48 text-center">
            <p className="text-sm font-medium text-text">No jobs yet</p>
            <p className="text-xs text-text-2">
              Hire an agent from the home page - every job you submit shows up here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
