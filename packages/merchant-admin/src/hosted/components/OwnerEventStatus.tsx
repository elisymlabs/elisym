import { useEffect, useRef, useState } from 'react';
import { type Finished, commitSigned, finishCommit } from '../lib/owner-flow';
import type { StoreSession } from '../lib/store-session';
import type { CommittedOwnerEvent } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { FinishedNotice } from './FinishedNotice';

interface Props {
  /** `payto` or `auth`: names the element ids. */
  id: string;
  committed: CommittedOwnerEvent;
  pendingStore: boolean;
  session: StoreSession;
  onChanged: () => void;
}

/**
 * Where O's newest signed event of one kind stands. Signed but not published
 * on an active store: Retry posts that very event back (no new signature),
 * from the view, so it works after a reload or on another device.
 */
export function OwnerEventStatus({ id, committed, pendingStore, session, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<Finished | undefined>(undefined);
  const lifetime = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const retry = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFinished(undefined);
    try {
      const { signal } = lifetime.current;
      const outcome = await commitSigned(session.api, committed.event, false);
      const next =
        outcome.kind === 'refused'
          ? { tone: 'error' as const, message: outcome.message }
          : await finishCommit(session.api, outcome, {
              signal,
              ...(session.sleep === undefined ? {} : { sleep: session.sleep }),
            });
      if (signal.aborted) {
        return;
      }
      setFinished(next);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  let status: string;
  if (committed.publishedAt !== null) {
    status = 'Signed and published.';
  } else if (pendingStore) {
    status = 'Signed. It goes live when PayCore activates your store.';
  } else {
    status = 'Signed, not published yet.';
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="text-14" id={`${id}-status`}>
        {status}
      </p>
      {committed.publishedAt === null && !pendingStore ? (
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={busy}
            onClick={() => void retry()}
          >
            Retry publishing
          </button>
        </div>
      ) : null}
      {finished === undefined ? null : (
        <FinishedNotice
          finished={finished}
          api={session.api}
          onRefreshed={(next) => {
            setFinished(next);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
