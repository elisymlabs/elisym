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
          Your wallet may still show a payment request from before. Reject it there: approving it
          would pay that earlier order too.
        </p>
        <p>
          {view.until > 0
            ? `If it is approved after ${new Date(view.until * 1000).toLocaleString()} (or after a price change), the store will not complete that order on its own: contact the store.`
            : 'If it is approved after a price change, the store will not complete that order on its own: contact the store.'}
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
