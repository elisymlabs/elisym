import type { View } from '../session';
import { StepHeading } from './StepHeading';

interface Props {
  view: Extract<View, { kind: 'old_prompt' }>;
  onContinue(): void;
  onBack(): void;
}

export function OldPromptStep({ view, onContinue, onBack }: Props) {
  return (
    <div class="step" data-step="old-prompt">
      <StepHeading level={3}>Check your wallet first</StepHeading>
      <div class="problem" role="alert">
        <p>
          An earlier payment request for this product may still be open in your wallet. Approving it
          would pay that order as well. Reject it in your wallet first.
        </p>
        <p>
          {view.until > 0
            ? `After ${new Date(view.until * 1000).toLocaleString()}, or if the store changed its price or payout, the store will not deliver that order on its own: you would have to contact it.`
            : 'If the store changed its price or payout, the store will not deliver that order on its own: you would have to contact it.'}
        </p>
      </div>
      <button type="button" class="primary" onClick={onContinue}>
        I understand, continue
      </button>
      <button type="button" class="secondary" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
