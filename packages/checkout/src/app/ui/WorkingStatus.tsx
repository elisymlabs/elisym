import { useEffect, useState } from 'preact/hooks';
import { type Rail, type View, payingRail } from '../session';
import { EIP3009_SENDING, EIP3009_SIGNING, WORKING, slowHint } from './text';
import { UnansweredHint } from './UnansweredHint';

interface Props {
  view: Extract<View, { kind: 'working' }>;
  /** How long a check may go unanswered before its hint (a wallet has no timeout). */
  hintAfterMs: number;
  /** How long a payment request may go unanswered before its hint. */
  unansweredHintMs: number;
  /** While the wallet has not answered its connect request: end the press and choose again. */
  onCancel(): void;
}

/** What the checkout is doing, and after a while with no answer, what the buyer can do. */
export function WorkingStatus({ view, hintAfterMs, unansweredHintMs, onCancel }: Props) {
  const [slow, setSlow] = useState(false);
  const step = view.step;
  const cancellable = view.cancellable === true;
  // A redraw of the same step (a new countdown) never restarts the wait for the hint.
  useEffect(() => {
    setSlow(false);
    if (step === 'ordering') {
      // Relay deadlines bound it: no hint.
      return undefined;
    }
    const timer = setTimeout(
      () => setSlow(true),
      step === 'signing' ? unansweredHintMs : hintAfterMs,
    );
    return () => clearTimeout(timer);
  }, [step, cancellable, hintAfterMs, unansweredHintMs]);
  const chain: Rail = view.paying === undefined ? 'solana' : payingRail(view.paying);
  let status: string = WORKING[step];
  if (step === 'signing' && chain === 'eip3009') {
    status = view.sendOnly === true ? EIP3009_SENDING : EIP3009_SIGNING;
  }
  return (
    <>
      <p class="status" role="status">
        {status}
      </p>
      {slow && step === 'checking' ? <p class="note hint">{slowHint(cancellable)}</p> : null}
      {slow && step === 'signing' ? (
        <UnansweredHint
          chain={chain}
          {...(view.startOverIn === undefined ? {} : { startOverIn: view.startOverIn })}
          {...(view.unsureAt === undefined ? {} : { unsureAt: view.unsureAt })}
        />
      ) : null}
      {cancellable ? (
        <button type="button" class="secondary" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </>
  );
}
