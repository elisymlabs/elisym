import { useState } from 'react';
import type { Plan } from '../constants';
import type { Billing } from './BillingSwitch';
import { PlanCard } from './PlanCard';
import { Segmented } from './Segmented';

interface Props {
  /** The sizes, smallest first: one card, its plan chosen with a switch. */
  plans: readonly Plan[];
  billing: Billing;
}

/** One card for several sizes of the same plan: the switch changes the price, limits and button. */
export function SizedPlanCard({ plans, billing }: Props) {
  const first = plans.find((plan) => plan.featured) ?? plans[0];
  const [chosen, setChosen] = useState(first?.name ?? '');
  const plan = plans.find((entry) => entry.name === chosen) ?? first;
  if (plan === undefined) {
    return null;
  }
  return (
    <PlanCard
      plan={plan}
      billing={billing}
      ink
      sizes={
        <div className="mt-10">
          <Segmented
            label="Plan size"
            options={plans.map((entry) => ({ value: entry.name, label: entry.name }))}
            value={plan.name}
            onChange={setChosen}
            onInk
          />
        </div>
      }
    />
  );
}
