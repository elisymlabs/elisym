import { PaymentStageIcon } from './PaymentStageIcon';
import type { View } from '../session';
import { ReceiptBlock } from './ReceiptBlock';
import { StepHeading } from './StepHeading';

interface Props {
  view: Extract<View, { kind: 'delivered' }>;
  onBuyAgain(): void;
  /** In a modal only: close it. */
  onDone?: () => void;
}

/**
 * "Payment complete" only when the receipt shows a payment: one this checkout's
 * verifier found, or the transaction it sent confirmed on chain. Otherwise the
 * store completed an order no payment is known for (a hand answer, a reverted
 * payment): "Order complete". Nothing is delivered through the checkout.
 */
export function doneHeading(view: Extract<View, { kind: 'delivered' }>): string {
  const receipt = view.receipt;
  return receipt?.paid !== undefined || receipt?.sent !== undefined
    ? 'Payment complete'
    : 'Order complete';
}

export function DoneStep({ view, onBuyAgain, onDone }: Props) {
  return (
    <div class="step done" data-step="done">
      <div class="success-symbol" aria-hidden="true">
        <PaymentStageIcon stage="complete" />
      </div>
      <StepHeading>{doneHeading(view)}</StepHeading>
      <div class="done-actions">
        <button
          type="button"
          class={onDone === undefined ? 'primary' : 'secondary'}
          onClick={onBuyAgain}
        >
          Buy again
        </button>
        {onDone === undefined ? null : (
          <button type="button" class="primary" onClick={onDone}>
            Done
          </button>
        )}
      </div>
      {view.receipt === undefined ? null : <ReceiptBlock receipt={view.receipt} kind="delivered" />}
    </div>
  );
}
