import type { Problem, View } from '../session';
import { StepHeading } from './StepHeading';
import { Stepper } from './Stepper';
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
}

function activeStage(view: ProgressView): number {
  switch (view.kind) {
    case 'working':
      return view.step === 'signing' ? 1 : 0;
    case 'waiting_payment':
      return view.canRetry ? 1 : 2;
    case 'waiting_store':
      return 3;
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
}: Props) {
  return (
    <div class="step" data-step="progress">
      <StepHeading level={3}>{heading(view)}</StepHeading>
      <Stepper active={activeStage(view)} />
      {view.kind === 'working' ? (
        <WorkingStatus view={view} hintAfterMs={hintAfterMs} onCancel={onCancel} />
      ) : null}
      {view.kind === 'waiting_payment' ? (
        <WaitingPayment view={view} problem={problem} onRetry={onRetry} onStartOver={onStartOver} />
      ) : null}
      {view.kind === 'waiting_store' ? <WaitingStore view={view} /> : null}
    </div>
  );
}
