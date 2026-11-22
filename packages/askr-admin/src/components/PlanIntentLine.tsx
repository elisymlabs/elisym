import type { ReactNode } from 'react';
import { PRICING_URL } from '../constants';
import { type PlanIntent, intentSummary } from '../lib/plan-intent';

interface Props {
  intent: PlanIntent;
  /**
   * What comes next, after the chosen plan, once signed in: in Onboarding, create the store to go
   * on to checkout, then pay now or describe the store first; in Billing, that its card is marked.
   */
  next: string;
  onDismiss: () => void;
  /** A button that acts on the plan, before the links. */
  children?: ReactNode;
}

/** The plan chosen on the landing (D3), with the way back to the plans and a way to drop it. */
export function PlanIntentLine({ intent, next, onDismiss, children }: Props) {
  return (
    <div id="plan-intent" className="card flex flex-col gap-10" role="status">
      <p className="text-14">
        {intentSummary(intent)} {next}
      </p>
      <div className="flex flex-wrap items-center gap-12">
        {children}
        <a
          className="text-13 text-text-2 hover:text-text underline underline-offset-2"
          href={PRICING_URL}
          target="_blank"
          rel="noreferrer"
        >
          Choose another plan
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
