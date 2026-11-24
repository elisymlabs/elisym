import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { type FinishTexts, type Finished, finishCommit, requestOutcome } from '../lib/owner-flow';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { FinishedNotice } from './FinishedNotice';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

/** What the merchant types to confirm. */
export const SUSPEND_WORD = 'suspend';

export const SUSPEND_EXPLAINED =
  'Suspending stops your store: every product is marked sold out on the relays; orders already placed can still be paid for a few days and their webhooks are still sent, then your store stops. You cannot undo this here: message us to open it again.';
export const TYPE_TO_CONFIRM = `Type "${SUSPEND_WORD}" to confirm.`;
export const WINDING_DOWN =
  'Your store is being suspended or is suspended: it takes no more changes.';

export const SUSPEND_TEXTS: FinishTexts = {
  done: 'Your store is being suspended.',
  onActivation: 'Your store is being suspended.',
  still: 'Your store is still applying the suspension: press Refresh in a moment.',
};

type Stage = { kind: 'idle' } | { kind: 'busy' } | { kind: 'finished'; finished: Finished };

/**
 * Suspend the store, once the merchant types the word. Hidden while the
 * store is pending (the server answers `inactive`: there is nothing to stop yet).
 */
export function SuspendStore({ session, view, onChanged }: Props) {
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const lifetime = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  if (view.status === 'pending') {
    return null;
  }

  const suspend = async () => {
    if (typed.trim().toLowerCase() !== SUSPEND_WORD) {
      setProblem(TYPE_TO_CONFIRM);
      return;
    }
    if (running.current) {
      return;
    }
    running.current = true;
    setProblem(undefined);
    setStage({ kind: 'busy' });
    let answer;
    try {
      answer = await session.api.suspend();
    } catch (error) {
      running.current = false;
      setProblem(errorMessage(error));
      setStage({ kind: 'idle' });
      return;
    }
    onChanged();
    const signal = lifetime.current?.signal;
    const finished = await finishCommit(
      session.api,
      requestOutcome(answer.request, false),
      {
        ...(signal === undefined ? {} : { signal }),
        ...(session.sleep === undefined ? {} : { sleep: session.sleep }),
      },
      SUSPEND_TEXTS,
    );
    if (signal?.aborted === true) {
      return;
    }
    setStage({ kind: 'finished', finished });
    onChanged();
  };

  let body;
  if (stage.kind === 'finished') {
    body = (
      <FinishedNotice
        finished={stage.finished}
        api={session.api}
        texts={SUSPEND_TEXTS}
        onRefreshed={(finished) => {
          setStage({ kind: 'finished', finished });
          onChanged();
        }}
      />
    );
  } else if (view.status === 'suspending' || view.status === 'suspended') {
    body = <p className="text-14 text-text-2">{WINDING_DOWN}</p>;
  } else {
    body = (
      <div className="flex flex-col gap-8">
        <p className="text-14 text-text-2">{SUSPEND_EXPLAINED}</p>
        <label className="text-14 flex flex-col gap-4">
          {TYPE_TO_CONFIRM}
          <input
            id="suspend-confirm"
            className={INPUT}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={stage.kind === 'busy'}
            onClick={() => void suspend()}
          >
            Suspend store
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-8" aria-labelledby="suspend-heading">
      <h2 id="suspend-heading" className="text-16 font-semibold">
        Suspend store
      </h2>
      {body}
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </section>
  );
}
