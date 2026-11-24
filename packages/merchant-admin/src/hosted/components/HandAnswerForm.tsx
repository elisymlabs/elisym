import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { type HandForm, handInput, refundCoins } from '../lib/hand-answer';
import { type FinishTexts, type Finished, finishCommit, requestOutcome } from '../lib/owner-flow';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { FinishedNotice } from './FinishedNotice';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  view: StoreView;
  /** The order key the unresolved payment is on. */
  orderKey: string;
  /** The store took the answer: the orders changed. */
  onAnswered: () => void;
}

export const HAND_TEXTS: FinishTexts = {
  done: 'Answered: your store recorded it and told the buyer.',
  onActivation: 'Answered. It goes out when PayCore activates your store.',
  still: 'Your store is still applying the answer: press Refresh in a moment.',
};

export const FINAL_FIRST = 'Tick the box to confirm: an order is answered by hand only once.';

type Stage = { kind: 'form' } | { kind: 'busy' } | { kind: 'finished'; finished: Finished };

/**
 * Answer one order by hand: complete it (the buyer is told it is delivered),
 * or record a refund already sent, with its transaction, amount and coin.
 * The answer is final, so it is sent only once the merchant ticks so.
 */
export function HandAnswerForm({ session, view, orderKey, onAnswered }: Props) {
  const coins = refundCoins(view);
  const [form, setForm] = useState<HandForm>({
    kind: 'complete',
    tx: '',
    amount: '',
    caip19: coins.length === 1 ? (coins[0]?.caip19 ?? '') : '',
  });
  const [final, setFinal] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const lifetime = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const id = `hand-${orderKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const send = async () => {
    if (!final) {
      setProblem(FINAL_FIRST);
      return;
    }
    const built = handInput(form);
    if (!built.ok) {
      setProblem(built.message);
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
      answer = await session.api.handAnswer(orderKey, built.input);
    } catch (error) {
      running.current = false;
      setProblem(errorMessage(error));
      setStage({ kind: 'form' });
      return;
    }
    onAnswered();
    const signal = lifetime.current?.signal;
    const finished = await finishCommit(
      session.api,
      requestOutcome(answer.request, view.status === 'pending'),
      {
        ...(signal === undefined ? {} : { signal }),
        ...(session.sleep === undefined ? {} : { sleep: session.sleep }),
      },
      HAND_TEXTS,
    );
    if (signal?.aborted === true) {
      return;
    }
    setStage({ kind: 'finished', finished });
    onAnswered();
  };

  if (stage.kind === 'finished') {
    return (
      <FinishedNotice
        finished={stage.finished}
        api={session.api}
        texts={HAND_TEXTS}
        onRefreshed={(finished) => {
          setStage({ kind: 'finished', finished });
          onAnswered();
        }}
      />
    );
  }

  const update = (edit: Partial<HandForm>) => setForm((current) => ({ ...current, ...edit }));

  return (
    <div className="flex flex-col gap-12">
      <fieldset className="flex flex-col gap-8">
        <legend className="text-14 mb-4 font-medium">Answer by hand</legend>
        <label className="text-14 flex items-center gap-8">
          <input
            type="radio"
            id={`${id}-complete`}
            name={`${id}-kind`}
            checked={form.kind === 'complete'}
            onChange={() => update({ kind: 'complete' })}
          />
          Complete the order: you checked the payment yourself, the buyer is told it is delivered
        </label>
        <label className="text-14 flex items-center gap-8">
          <input
            type="radio"
            id={`${id}-refunded`}
            name={`${id}-kind`}
            checked={form.kind === 'refunded'}
            onChange={() => update({ kind: 'refunded' })}
          />
          Record a refund you already sent from your wallet
        </label>
      </fieldset>
      {form.kind === 'refunded' ? (
        <div className="flex flex-col gap-12">
          <label className="text-14 flex flex-col gap-4">
            Refund transaction
            <input
              id={`${id}-tx`}
              className={INPUT}
              value={form.tx}
              onChange={(event) => update({ tx: event.target.value })}
            />
          </label>
          <label className="text-14 flex flex-col gap-4">
            Coin
            <select
              id={`${id}-coin`}
              className={INPUT}
              value={form.caip19}
              onChange={(event) => update({ caip19: event.target.value })}
            >
              <option value="">Choose the coin</option>
              {coins.map((coin) => (
                <option key={coin.caip19} value={coin.caip19}>
                  {coin.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-14 flex flex-col gap-4">
            Amount refunded, in the coin (such as 12.50)
            <input
              id={`${id}-amount`}
              className={INPUT}
              inputMode="decimal"
              value={form.amount}
              onChange={(event) => update({ amount: event.target.value })}
            />
          </label>
        </div>
      ) : null}
      <label className="text-14 flex items-center gap-8">
        <input
          type="checkbox"
          id={`${id}-final`}
          checked={final}
          onChange={(event) => setFinal(event.target.checked)}
        />
        This answer is final: an order is answered by hand only once
      </label>
      <div>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={stage.kind === 'busy'}
          onClick={() => void send()}
        >
          Send answer
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </div>
  );
}
