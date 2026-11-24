import { useEffect, useRef, useState } from 'react';
import { GENERIC_ERROR } from '../lib/errors';
import {
  type Checked,
  type Finished,
  commitSigned,
  finishCommit,
  prepareChecked,
} from '../lib/owner-flow';
import type { StoreSession } from '../lib/store-session';
import type { OwnerEventKind, Payout } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { ConfirmOwnerEvent } from './ConfirmOwnerEvent';
import { FinishedNotice } from './FinishedNotice';

interface Props {
  kind: OwnerEventKind;
  label: string;
  session: StoreSession;
  storePubkey: string;
  /** A pending store applies owner events at its activation: nothing to follow before. */
  pendingStore: boolean;
  /** The payout rows the payout list must name, in order. */
  payouts: readonly Payout[];
  /** Offer the button: the event is not signed yet, or no longer current. */
  needed: boolean;
  /** The server took the signed event: the view changed. */
  onCommitted: () => void;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'confirm'; checked: Checked }
  | { kind: 'finished'; finished: Finished };

/**
 * One owner event (A13): prepare, check locally, confirm, sign with O,
 * commit, then follow. A commit refused because the prepared change went
 * stale is prepared again once, by itself, and signed with no second confirm:
 * the fresh template passed the same check against the same rows, so it names
 * the addresses the merchant confirmed. Leaving the page stops the follow.
 */
export function OwnerEventAction({
  kind,
  label,
  session,
  storePubkey,
  pendingStore,
  payouts,
  needed,
  onCommitted,
}: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const { api } = session;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const prepare = () =>
    prepareChecked(api, {
      kind,
      payouts,
      storePubkey,
      operator: session.operator,
      localNow: session.localNow(),
    });

  const fail = (message: string) =>
    setStage({ kind: 'finished', finished: { tone: 'error', message } });

  const signAndCommit = async (checked: Checked, preparedAgain: boolean): Promise<void> => {
    let event;
    try {
      event = await session.signEvent(checked.template);
    } catch {
      fail(GENERIC_ERROR);
      return;
    }
    const outcome = await commitSigned(api, event, pendingStore);
    if (outcome.kind !== 'refused') {
      // The server took it: the store view changed, read it again even if this page is left.
      onCommitted();
      const signal = lifetime.current?.signal;
      const finished = await finishCommit(api, outcome, {
        ...(signal === undefined ? {} : { signal }),
        ...(session.sleep === undefined ? {} : { sleep: session.sleep }),
      });
      if (signal?.aborted === true) {
        return;
      }
      setStage({ kind: 'finished', finished });
      onCommitted();
      return;
    }
    if (!outcome.prepareAgain || preparedAgain) {
      fail(outcome.message);
      return;
    }
    const again = await prepare();
    if (!again.ok) {
      fail(again.message);
      return;
    }
    await signAndCommit(again.checked, true);
  };

  const exclusive = async (work: () => Promise<void>) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setStage({ kind: 'busy' });
    try {
      await work();
    } finally {
      running.current = false;
    }
  };

  const start = () =>
    exclusive(async () => {
      const prepared = await prepare();
      if (!prepared.ok) {
        fail(prepared.message);
        return;
      }
      setStage({ kind: 'confirm', checked: prepared.checked });
    });

  if (stage.kind === 'confirm') {
    const { checked } = stage;
    return (
      <ConfirmOwnerEvent
        key={checked.template.created_at}
        checked={checked}
        storePubkey={storePubkey}
        operator={session.operator}
        proven={session.proven}
        onSign={() => void exclusive(() => signAndCommit(checked, false))}
        onCancel={() => setStage({ kind: 'idle' })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {needed || stage.kind === 'busy' ? (
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={stage.kind === 'busy'}
            onClick={() => void start()}
          >
            {label}
          </button>
        </div>
      ) : null}
      {stage.kind === 'busy' ? (
        <p className="text-13 text-text-2" role="status">
          Working...
        </p>
      ) : null}
      {stage.kind === 'finished' ? (
        <FinishedNotice
          finished={stage.finished}
          api={api}
          onRefreshed={(finished) => {
            setStage({ kind: 'finished', finished });
            onCommitted();
          }}
        />
      ) : null}
    </div>
  );
}
