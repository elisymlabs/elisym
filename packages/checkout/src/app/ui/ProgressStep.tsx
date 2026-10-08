import type { Countdown, Problem, View } from '../session';
import { secondsLeft, useNow } from './clock';
import { StepHeading } from './StepHeading';
import { Stepper } from './Stepper';
import { STEPPER_STAGES } from './text';
import { WaitingPayment } from './WaitingPayment';
import { WaitingStore } from './WaitingStore';
import { WorkingStatus } from './WorkingStatus';

type ProgressView = Extract<View, { kind: 'working' | 'waiting_payment' | 'waiting_store' }>;

interface Props {
  view: ProgressView;
  problem: Problem | undefined;
  onRetry(name: string): void;
  /** Ask the Solana wallet that failed this attempt again. */
  onSignAgain(): void;
  onStartOver(): void;
  onCancel(): void;
  hintAfterMs: number;
  /** How long a payment request may go unanswered before its hint. */
  unansweredHintMs: number;
  /** The payment is complete: every stage is done (the last one fills). */
  complete?: boolean;
  /** Held on screen for a moment before the done screen: nothing in it can be pressed. */
  busy?: boolean;
}

function activeStage(view: ProgressView): number {
  switch (view.kind) {
    case 'working':
      return view.step === 'signing' ? 1 : 0;
    case 'waiting_payment':
      // Nothing signed, and nothing seen on chain: the wallet step is still the current one.
      return view.canRetry || (!view.signed && view.seenOnChain !== true) ? 1 : 2;
    case 'waiting_store':
      // Paid: the payment is complete, only the store's answer is left.
      return STEPPER_STAGES.length;
  }
}

/** The countdown the wait shows (the request's on Tempo, the retry's on Solana), if any. */
function waitCountdown(view: ProgressView): Countdown | undefined {
  if (view.kind !== 'waiting_payment') {
    return undefined;
  }
  return view.tempo ? view.requestEndsIn : view.retryIn;
}

/** `left`: the seconds the wait's countdown has left, if it has one. */
function heading(view: ProgressView, left: number | undefined): string {
  switch (view.kind) {
    case 'working':
      return 'Paying';
    case 'waiting_payment':
      if (view.canRetry) {
        return 'Payment not made';
      }
      if (!view.signed && view.tempo) {
        return 'Waiting for your wallet';
      }
      // At 0 the checkout is checking, and a transaction seen is being confirmed.
      if (!view.signed && !view.unserved && left !== 0 && view.seenOnChain !== true) {
        return 'Payment not sent yet';
      }
      return 'Confirming payment';
    case 'waiting_store':
      return view.cancelled ? 'Order cancelled' : 'Paid';
  }
}

/** Working and waiting, in the wallet section's place: where the purchase is, and what is left to do. */
export function ProgressStep({
  view,
  problem,
  onRetry,
  onSignAgain,
  onStartOver,
  onCancel,
  hintAfterMs,
  unansweredHintMs,
  complete = false,
  busy = false,
}: Props) {
  // The heading flips with the countdown, as the wait's own line does, with no new view.
  const countdown = waitCountdown(view);
  const now = useNow(countdown !== undefined);
  const left = countdown === undefined ? undefined : secondsLeft(countdown, now);
  return (
    <div
      class="step"
      data-step="progress"
      {...(busy ? { inert: true, 'aria-busy': 'true' as const } : {})}
    >
      <StepHeading level={3}>{heading(view, left)}</StepHeading>
      <Stepper active={complete ? STEPPER_STAGES.length : activeStage(view)} />
      {view.kind === 'working' ? (
        <WorkingStatus
          view={view}
          hintAfterMs={hintAfterMs}
          unansweredHintMs={unansweredHintMs}
          onCancel={onCancel}
        />
      ) : null}
      {view.kind === 'waiting_payment' ? (
        <WaitingPayment
          view={view}
          problem={problem}
          onRetry={onRetry}
          onSignAgain={onSignAgain}
          onStartOver={onStartOver}
        />
      ) : null}
      {view.kind === 'waiting_store' ? <WaitingStore view={view} /> : null}
    </div>
  );
}
