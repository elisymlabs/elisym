import { useRef, useState } from 'react';
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
  | { kind: 'confirm'; checked: Checked; preparedAgain: boolean }
  | { kind: 'finished'; finished: Finished };

function sameAccept(left: Checked, right: Checked): boolean {
  return JSON.stringify(left.accept) === JSON.stringify(right.accept);
}

/**
 * One owner event (A13): prepare, check locally, confirm, sign with O,
 * commit, then follow. A commit refused because the prepared change went
 * stale is prepared again once, by itself.
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
  const { api } = session;

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
      const finished = await finishCommit(
        api,
        outcome,
        session.sleep === undefined ? {} : { sleep: session.sleep },
      );
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
    if (sameAccept(again.checked, checked)) {
      await signAndCommit(again.checked, true);
      return;
    }
    setStage({ kind: 'confirm', checked: again.checked, preparedAgain: true });
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
      setStage({ kind: 'confirm', checked: prepared.checked, preparedAgain: false });
    });

  if (stage.kind === 'confirm') {
    const { checked, preparedAgain } = stage;
    return (
      <ConfirmOwnerEvent
        key={checked.template.created_at}
        checked={checked}
        storePubkey={storePubkey}
        operator={session.operator}
        proven={session.proven}
        busy={false}
        onSign={() => void exclusive(() => signAndCommit(checked, preparedAgain))}
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
