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
      <div class="old-prompt-warning" role="note">
        <StepHeading level={3}>An earlier payment request may still be open</StepHeading>
        <p>Reject the earlier Tempo request in your wallet before continuing. Approving it could also pay the previous order.</p>
        <p class="old-prompt-followup">
          {view.until > 0
            ? `If approved after ${new Date(view.until * 1000).toLocaleString()} or after a price change, the store may not complete that order automatically. Contact the store.`
            : 'If approved after a price change, the store may not complete that order automatically. Contact the store.'}
        </p>
      </div>
      <div class="old-prompt-actions">
        <button type="button" class="secondary" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 12H5m6-6-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Back
        </button>
        <button type="button" class="primary" onClick={onContinue}>
          Continue to Payment
        </button>
      </div>
    </div>
  );
}
