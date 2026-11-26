import { useState } from 'react';
import {
  EVM_REFUNDS_LATER,
  type HandForm,
  handInput,
  refundCoins,
  refundsLaterCoins,
} from '../lib/hand-answer';
import type { FinishTexts } from '../lib/owner-flow';
import type { HandInput, StoreView } from '../lib/types';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { Notice } from './Notice';

interface Props {
  view: StoreView;
  /** The order key the unresolved payment is on. */
  orderKey: string;
  /** An answer is being sent. */
  busy: boolean;
  /** Why the server refused the last answer sent, in a fixed sentence. */
  refusal?: string | undefined;
  onSend: (input: HandInput) => void;
}

export const HAND_TEXTS: FinishTexts = {
  done: 'Answered: your store recorded it and told the buyer.',
  onActivation: 'Answered. It goes out when PayCore activates your store.',
  still: 'Your store is still applying the answer: press Refresh in a moment.',
};

export const FINAL_FIRST = 'Tick the box to confirm: an order is answered by hand only once.';

/**
 * The hand answer for one order: complete it (the buyer is told it is
 * delivered), or record a refund already sent, with its transaction, amount
 * and coin. The answer is final, so it is sent only once the merchant ticks
 * so. The row sends it and keeps how it ended.
 */
export function HandAnswerForm({ view, orderKey, busy, refusal, onSend }: Props) {
  const coins = refundCoins(view);
  const later = refundsLaterCoins(view);
  const [form, setForm] = useState<HandForm>({
    kind: 'complete',
    tx: '',
    amount: '',
    caip19: coins.length === 1 ? (coins[0]?.caip19 ?? '') : '',
  });
  const [final, setFinal] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = `hand-${orderKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const shown = problem ?? refusal;

  const send = () => {
    if (!final) {
      setProblem(FINAL_FIRST);
      return;
    }
    const built = handInput(form);
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    setProblem(undefined);
    onSend(built.input);
  };

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
            disabled={coins.length === 0}
            onChange={() => update({ kind: 'refunded' })}
          />
          Record a refund you already sent from your wallet
        </label>
      </fieldset>
      {later.length === 0 ? null : <Notice tone="info">{EVM_REFUNDS_LATER(later)}</Notice>}
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
        <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={send}>
          Send answer
        </button>
      </div>
      {shown === undefined ? null : <Notice tone="error">{shown}</Notice>}
    </div>
  );
}
