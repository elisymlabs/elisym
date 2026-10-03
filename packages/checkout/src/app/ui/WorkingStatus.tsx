import { useEffect, useState } from 'preact/hooks';
import type { Rail, View } from '../session';
import { WORKING, slowHint } from './text';

interface Props {
  view: Extract<View, { kind: 'working' }>;
  /** How long an action may go unanswered before the hint (a wallet has no timeout). */
  hintAfterMs: number;
  /** While the wallet has not answered its connect request: end the press and choose again. */
  onCancel(): void;
}

/** What the checkout is doing, and after a while with no answer, what the buyer can do. */
export function WorkingStatus({ view, hintAfterMs, onCancel }: Props) {
  const [slow, setSlow] = useState(false);
  const step = view.step;
  useEffect(() => {
    setSlow(false);
    if (step === 'ordering') {
      // Relay deadlines bound it: no hint.
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), hintAfterMs);
    return () => clearTimeout(timer);
  }, [view, step, hintAfterMs]);
  const chain: Rail = view.paying?.chain ?? 'solana';
  const cancellable = view.cancellable === true;
  return (
    <>
      <p class="status" role="status">
        {WORKING[step]}
      </p>
      {slow && step !== 'ordering' ? (
        <p class="note hint">{slowHint(step, chain, cancellable)}</p>
      ) : null}
      {cancellable ? (
        <button type="button" class="secondary" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </>
  );
}
