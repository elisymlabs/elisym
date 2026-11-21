import type { ReactNode, Ref } from 'react';
import { CONTACT_URL } from '../constants';
import type { CardAction } from '../lib/plan-actions';
import type { PaidPlan } from '../lib/types';

interface Props {
  action: CardAction;
  /** The card's paid plan; undefined for Free and Enterprise. */
  plan: PaidPlan | undefined;
  /** Which button is at work (a plan, or `cancel`): every other one waits. */
  busy: string | undefined;
  /** The checkout continues the plan chosen on the landing. */
  continues: boolean;
  /** Start on Free, with its own settings check and refusals. */
  startFree: ReactNode;
  /** Set on the button of the plan chosen on the landing: it takes the focus. */
  focusRef?: Ref<HTMLButtonElement>;
  onCheckout: (plan: PaidPlan) => void;
  onSwitch: (plan: PaidPlan) => void;
  onCancel: () => void;
}

/** What one plan card offers (D6.3): a button, the Contact us link, or "Current plan". */
export function PlanCardAction({
  action,
  plan,
  busy,
  continues,
  startFree,
  focusRef,
  onCheckout,
  onSwitch,
  onCancel,
}: Props) {
  const waiting = busy !== undefined;
  if (action.kind === 'start-free') {
    return startFree;
  }
  if (action.kind === 'current') {
    return (
      <p className="text-13 text-text-2 rounded-8 bg-surface-2 py-6 text-center font-medium">
        Current plan
      </p>
    );
  }
  if (action.kind === 'contact') {
    return (
      <a className="btn w-full" href={CONTACT_URL} target="_blank" rel="noreferrer">
        Contact us
      </a>
    );
  }
  if (action.kind === 'cancel') {
    return (
      <button
        type="button"
        id="cancel-plan"
        className="btn w-full"
        disabled={waiting}
        aria-busy={busy === 'cancel'}
        onClick={onCancel}
      >
        Cancel plan
      </button>
    );
  }
  if (plan === undefined || action.kind === 'none') {
    return null;
  }
  if (action.kind === 'checkout') {
    return (
      <button
        type="button"
        id={`upgrade-${plan}`}
        ref={focusRef}
        className="btn btn-primary w-full"
        disabled={waiting}
        aria-busy={busy === plan}
        onClick={() => onCheckout(plan)}
      >
        {continues ? 'Continue to checkout' : 'Upgrade'}
      </button>
    );
  }
  return (
    <button
      type="button"
      id={`change-${plan}`}
      ref={focusRef}
      className={`btn w-full ${action.label === 'Upgrade' ? 'btn-primary' : ''}`}
      disabled={waiting}
      aria-busy={busy === plan}
      onClick={() => onSwitch(plan)}
    >
      {action.label}
    </button>
  );
}
