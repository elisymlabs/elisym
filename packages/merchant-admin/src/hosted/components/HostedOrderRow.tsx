import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { ORDER_STATE_LABELS, type OrderEntry, utcText } from '../lib/orders';
import { type Finished, finishCommit, requestOutcome } from '../lib/owner-flow';
import type { StoreSession } from '../lib/store-session';
import type { HandInput, StoreView } from '../lib/types';
import { FinishedNotice } from './FinishedNotice';
import { HAND_TEXTS, HandAnswerForm } from './HandAnswerForm';
import { HostedOrderDetails } from './HostedOrderDetails';

interface Props {
  session: StoreSession;
  view: StoreView;
  entry: OrderEntry;
  onAnswered: () => void;
}

type Answer =
  | { kind: 'idle'; refusal?: string }
  | { kind: 'busy' }
  | { kind: 'finished'; finished: Finished };

/**
 * One order: its summary, and on demand its details and, for an unresolved
 * payment, the hand answer. The row sends the answer and keeps how it ended,
 * so collapsing it neither stops the follow nor offers a second answer.
 */
export function HostedOrderRow({ session, view, entry, onAnswered }: Props) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer>({ kind: 'idle' });
  const running = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const { order } = entry;
  // Once answered here the outcome shows instead (checked first below), never a second form.
  const answerable = entry.unresolved.length > 0 && entry.hand === undefined;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const send = async (input: HandInput) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setAnswer({ kind: 'busy' });
    let taken;
    try {
      taken = await session.api.handAnswer(entry.key, input);
    } catch (error) {
      running.current = false;
      setAnswer({ kind: 'idle', refusal: errorMessage(error) });
      return;
    }
    onAnswered();
    const signal = lifetime.current?.signal;
    const finished = await finishCommit(
      session.api,
      requestOutcome(taken.request, view.status === 'pending'),
      {
        ...(signal === undefined ? {} : { signal }),
        ...(session.sleep === undefined ? {} : { sleep: session.sleep }),
      },
      HAND_TEXTS,
    );
    if (signal?.aborted === true) {
      return;
    }
    setAnswer({ kind: 'finished', finished });
    onAnswered();
  };

  let outcome;
  if (answer.kind === 'finished') {
    outcome = (
      <FinishedNotice
        finished={answer.finished}
        api={session.api}
        texts={HAND_TEXTS}
        onRefreshed={(finished) => {
          setAnswer({ kind: 'finished', finished });
          onAnswered();
        }}
      />
    );
  } else if (answerable) {
    outcome = (
      <HandAnswerForm
        view={view}
        orderKey={entry.key}
        busy={answer.kind === 'busy'}
        refusal={answer.kind === 'idle' ? answer.refusal : undefined}
        onSend={(input) => void send(input)}
      />
    );
  }

  return (
    <li className="border-line flex flex-col gap-12 border-b py-12" data-order={entry.key}>
      <button
        type="button"
        className="text-14 flex flex-wrap items-baseline gap-x-12 gap-y-4 text-left"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="text-text-2 font-mono">
          {order === undefined ? 'closed' : utcText(order.createdAt).slice(0, 16)}
        </span>
        <span className="font-mono break-all">{entry.orderId}</span>
        <span data-field="state" className="font-semibold">
          {ORDER_STATE_LABELS[entry.state]}
        </span>
        {order === undefined ? null : (
          <span className="text-text-2">{order.productTitle ?? 'deleted product'}</span>
        )}
        {order?.email === undefined ? null : (
          <span className="text-text-2 break-all">{order.email}</span>
        )}
      </button>
      {open ? (
        <div className="flex flex-col gap-16 pl-12">
          <HostedOrderDetails entry={entry} />
          {outcome}
          {answer.kind === 'busy' ? (
            <p className="text-13 text-text-2" role="status">
              Sending the answer...
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
