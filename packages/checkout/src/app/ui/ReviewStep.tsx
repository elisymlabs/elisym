import { type Problem, type View, payoutPaying } from '../session';
import { EmailField } from './EmailField';
import { PayoutChips } from './PayoutChips';
import { ProblemNote } from './ProblemNote';
import { StepHeading } from './StepHeading';
import { payoutLabel } from './text';
import { Warnings } from './Warnings';

interface Props {
  view: Extract<View, { kind: 'offer' }>;
  problem: Problem | undefined;
  email: string;
  onEmail(value: string): void;
  onConfirm(checked: boolean): void;
  onChoose(index: number): void;
  onContinue(): void;
}

export function ReviewStep({
  view,
  problem,
  email,
  onEmail,
  onConfirm,
  onChoose,
  onContinue,
}: Props) {
  const { product } = view.offer.offer;
  const paying = payoutPaying(view.payout);
  const shortcut = view.confirm.length === 0 && view.payouts.length < 2;
  return (
    <div class="step" data-step="review">
      <StepHeading>{product.title}</StepHeading>
      {product.summary === undefined ? null : <p class="summary">{product.summary}</p>}
      <p class="price">
        {product.price.amount} {product.price.currency}
      </p>
      {view.payouts.length < 2 ? (
        <p class="pay-label">{payoutLabel(paying)}</p>
      ) : (
        <div class="pay-with">
          <p class="label">Pay with</p>
          <PayoutChips payouts={view.payouts} selected={view.payoutIndex} onChoose={onChoose} />
        </div>
      )}
      <Warnings
        warnings={[...view.confirm, ...view.notices]}
        confirm={
          view.confirm.length === 0 ? undefined : { checked: view.confirmed, onChange: onConfirm }
        }
      />
      {view.askEmail ? (
        <EmailField value={email} onInput={onEmail} continuing={view.continuing} />
      ) : null}
      {!view.askEmail && view.continuing !== false ? (
        <p class="note">
          {view.continuing === 'created'
            ? 'Your earlier order is being sent.'
            : 'Your earlier order is still open.'}
        </p>
      ) : null}
      <ProblemNote problem={problem} asset={paying.asset} tempo={paying.chain === 'tempo'} />
      <button type="button" class="primary" disabled={!view.confirmed} onClick={onContinue}>
        {shortcut ? 'Choose wallet' : 'Continue'}
      </button>
    </div>
  );
}
