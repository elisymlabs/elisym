import { cycleOf, isLive, planName, scheduledChangeOf } from '../lib/billing';
import type { SessionDeps } from '../lib/deps';
import { currentPlanOf } from '../lib/plan-actions';
import type { StoreView } from '../lib/types';
import { BillingStatus } from './BillingStatus';

interface Props {
  deps: Pick<SessionDeps, 'api' | 'openUrl'>;
  view: StoreView;
  /** The portal opened: the page is leaving. */
  onOpened?: () => void;
}

const STORE_BADGE: Readonly<Record<StoreView['status'], { label: string; tone: string }>> = {
  pending: { label: 'Pending', tone: 'badge-warn' },
  active: { label: 'Active', tone: 'badge-green' },
  suspended: { label: 'Suspended', tone: 'badge-error' },
};

/** The badge beside the plan: the subscription's state while one is live, else the store's. */
function badgeOf(view: StoreView): { label: string; tone: string } {
  const { billing } = view;
  if (!isLive(billing)) {
    return STORE_BADGE[view.status];
  }
  if (billing.status === 'past_due') {
    return { label: 'Payment failed', tone: 'badge-warn' };
  }
  if (billing.cancelAtPeriodEnd) {
    return { label: 'Canceled', tone: 'badge-warn' };
  }
  if (scheduledChangeOf(billing) !== undefined) {
    return { label: 'Change scheduled', tone: 'badge-warn' };
  }
  return billing.status === 'trialing'
    ? { label: 'Trial', tone: 'badge-green' }
    : { label: 'Active', tone: 'badge-green' };
}

/** The plan's name and period as the block heads it. */
function nameOf(view: StoreView): string {
  const current = currentPlanOf(view);
  if (current === 'free') {
    return 'Free';
  }
  if (current !== undefined) {
    return `${planName(current.plan)}, billed ${cycleOf(current.interval)}`;
  }
  return view.tier === null ? 'No plan yet' : view.tier.name;
}

/** Billing's first block: the plan the store is on, its state, its limits and Manage billing. */
export function CurrentPlan({ deps, view, onOpened }: Props) {
  const badge = badgeOf(view);
  const { tier } = view;
  return (
    <div id="current-plan" className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-12">
        <p id="current-plan-name" className="text-16 font-semibold">
          {nameOf(view)}
        </p>
        <span className={`badge ${badge.tone}`}>{badge.label}</span>
      </div>
      <BillingStatus
        deps={deps}
        billing={view.billing}
        {...(onOpened === undefined ? {} : { onOpened })}
      />
      {tier === null ? null : (
        <p className="text-13 text-text-2">
          Up to {tier.maxProducts} products, {tier.messagesPerSessionPerDay} questions per visitor
          per day, connector sync every {tier.syncIntervalMinutes} minutes.
        </p>
      )}
    </div>
  );
}
