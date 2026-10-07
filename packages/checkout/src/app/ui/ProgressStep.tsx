import type { Problem, View } from '../session';
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
      return view.canRetry ? 1 : 2;
    case 'waiting_store':
      // Paid: the payment is complete, only the store's answer is left.
      return STEPPER_STAGES.length;
  }
}

function heading(view: ProgressView): string {
  switch (view.kind) {
    case 'working':
      return 'Paying';
    case 'waiting_payment':
      return view.canRetry ? 'Payment not made' : 'Confirming payment';
    case 'waiting_store':
      return view.cancelled ? 'Order cancelled' : 'Paid';
  }
}

/** Working and waiting, in the wallet section's place: where the purchase is, and what is left to do. */
export function ProgressStep({
  view,
  problem,
  onRetry,
  onStartOver,
  onCancel,
  hintAfterMs,
  unansweredHintMs,
  complete = false,
  busy = false,
}: Props) {
  return (
    <div
      class="step"
      data-step="progress"
      {...(busy ? { inert: true, 'aria-busy': 'true' as const } : {})}
    >
      <StepHeading level={3}>{heading(view)}</StepHeading>
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
        <WaitingPayment view={view} problem={problem} onRetry={onRetry} onStartOver={onStartOver} />
      ) : null}
      {view.kind === 'waiting_store' ? <WaitingStore view={view} /> : null}
    </div>
  );
}
