import { PRICING_URL } from '../constants';
import { type PlanIntent, intentShortSummary } from '../lib/plan-intent';

interface Props {
  intent: PlanIntent;
  onDismiss: () => void;
}

/**
 * The plan chosen on the landing in one compact line, before sign-in: the way back to the plans
 * and a way to drop it.
 */
export function PlanChoiceLine({ intent, onDismiss }: Props) {
  return (
    <div
      id="plan-intent"
      role="status"
      className="border-line bg-surface rounded-10 flex flex-wrap items-center justify-between gap-x-16 gap-y-6 border px-14 py-10"
    >
      <p className="text-14 font-medium">{intentShortSummary(intent)}</p>
      <div className="flex items-center gap-12">
        <a
          className="text-13 text-text-2 hover:text-text underline underline-offset-2"
          href={PRICING_URL}
          target="_blank"
          rel="noreferrer"
        >
          Change plan
        </a>
        <button
          type="button"
          className="text-13 text-text-2 hover:text-text underline underline-offset-2"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
