import type { ReactNode } from 'react';
import type { PlanChoice } from '../lib/plans';
import type { BillingInterval } from '../lib/types';

interface Props {
  plan: PlanChoice;
  interval: BillingInterval;
  /** The plan the owner chose on the landing: drawn out. */
  chosen: boolean;
  /** What the card offers: a button, a link, or a line. */
  children: ReactNode;
}

/** The price as the card shows it under `interval`: the figure, its unit and the line under it. */
function shownPrice(
  plan: PlanChoice,
  interval: BillingInterval,
): { figure: string; unit: string; note: string } {
  if (plan.from === true) {
    return { figure: `from ${plan.monthly}`, unit: '/ month', note: 'Terms by agreement' };
  }
  if (plan.monthly === '$0') {
    return { figure: plan.monthly, unit: '/ month', note: 'No payment needed' };
  }
  if (interval === 'year') {
    return {
      figure: plan.yearlyPerMonth ?? plan.monthly,
      unit: '/ month',
      note: `Subscription, ${plan.yearlyTotal ?? ''} billed yearly`,
    };
  }
  return { figure: plan.monthly, unit: '/ month', note: 'Monthly subscription' };
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="text-text-2 mt-3 size-14 flex-none"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** One plan, as the landing's card: its name, blurb, price under the chosen period and features. */
export function PlanCard({ plan, interval, chosen, children }: Props) {
  const { figure, unit, note } = shownPrice(plan, interval);
  const slug = plan.name.toLowerCase();
  return (
    <li
      id={`plan-${slug}`}
      data-chosen={chosen ? 'true' : undefined}
      className={`plan-card ${chosen ? 'plan-card-chosen' : ''}`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-8">
          <h3 className="text-16 font-semibold">{plan.name}</h3>
          {plan.featured ? (
            <span className="bg-ink text-ink-text text-12 rounded-full px-8 py-1 font-medium">
              Most popular
            </span>
          ) : null}
        </div>
        <p className="text-13 text-text-2">{plan.blurb}</p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="flex items-baseline gap-6">
          <span className="text-24 font-semibold tabular-nums">{figure}</span>
          <span className="text-13 text-text-3">{unit}</span>
        </p>
        <p className="text-12 text-text-3">{note}</p>
      </div>
      <ul className="flex flex-col gap-6">
        {plan.features.map((feature) => (
          <li key={feature} className="text-13 flex gap-8">
            <CheckIcon />
            {feature}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-col gap-6" data-action="">
        {children}
      </div>
    </li>
  );
}
