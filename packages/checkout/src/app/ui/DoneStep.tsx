import type { View } from '../session';
import { CopyText } from './CopyText';
import { DeliveryLink } from './DeliveryLink';
import { CHECK_GLYPH } from './glyphs';
import { ReceiptBlock } from './ReceiptBlock';
import { StepHeading } from './StepHeading';

interface Props {
  view: Extract<View, { kind: 'delivered' }>;
  onBuyAgain(): void;
  /** In a modal only: close it. */
  onDone?: () => void;
}

export function DoneStep({ view, onBuyAgain, onDone }: Props) {
  return (
    <div class="step done" data-step="done">
      <img class="mark" src={CHECK_GLYPH} alt="" aria-hidden="true" />
      <StepHeading>Delivered</StepHeading>
      {view.link === undefined ? <CopyText text={view.text} /> : <DeliveryLink link={view.link} />}
      {onDone === undefined ? null : (
        <button type="button" class="secondary" onClick={onDone}>
          Done
        </button>
      )}
      <button type="button" class="secondary" onClick={onBuyAgain}>
        Buy again
      </button>
      {view.receipt === undefined ? null : <ReceiptBlock receipt={view.receipt} kind="delivered" />}
    </div>
  );
}
