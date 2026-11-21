import type { ReactNode } from 'react';
import { BUTTON } from '../buttons';
import { CONTACT_URL, type FlatPlan, PRICE_TAX_NOTE, START_LABEL } from '../constants';
import { AdminLink } from './AdminLink';
import type { Billing } from './BillingSwitch';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';

interface Props {
  plan: FlatPlan;
  billing: Billing;
  /** Drawn on ink whichever size is chosen: the card that holds the sizes. */
  ink?: boolean;
  /** Under the blurb: the size switch, for the card that holds several plans. */
  sizes?: ReactNode;
  className?: string;
}

/** What the plan costs under the chosen billing: the big figure, its unit and the line under it. */
function shownPrice(
  plan: FlatPlan,
  billing: Billing,
): { figure: string; unit: string; note: string } {
  const { price } = plan;
  if (price.monthly === '$0') {
    return { figure: price.monthly, unit: '/ month', note: 'No payment needed' };
  }
  if (billing === 'yearly') {
    return {
      figure: price.yearlyPerMonth,
      unit: `/ month ${PRICE_TAX_NOTE}`,
      note: `Subscription, ${price.yearlyTotal} billed yearly`,
    };
  }
  return { figure: price.monthly, unit: `/ month ${PRICE_TAX_NOTE}`, note: 'Monthly subscription' };
}

/** One plan: its price under the chosen billing, what it includes, and how to start on it. */
export function PlanCard({ plan, billing, ink = plan.featured, sizes, className = '' }: Props) {
  const button = `${ink ? BUTTON.light : BUTTON.ghost} mt-auto w-full`;
  const { figure, unit, note } = shownPrice(plan, billing);
  return (
    <li
      className={`rounded-32 relative flex flex-col gap-24 border p-24 ${className} ${ink ? 'bg-ink text-on-ink border-ink shadow-[0_40px_80px_-30px_rgb(18_19_22/0.5)]' : 'bg-surface border-line'}`}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-8">
          <h3 className="text-28 font-serif">{plan.name}</h3>
          {plan.featured && (
            <span className="bg-on-ink-accent text-11 text-ink rounded-full px-10 py-4 font-semibold">
              Most popular
            </span>
          )}
        </div>
        <p className={`text-14 xl:min-h-44 ${ink ? 'text-on-ink-2' : 'text-text-2'}`}>
          {plan.blurb}
        </p>
        {sizes}
      </div>
      <div className="flex flex-col gap-6">
        <p className="flex items-baseline gap-6">
          <span className="text-48 font-serif leading-none tabular-nums">{figure}</span>
          <span className={`text-14 ${ink ? 'text-on-ink-2' : 'text-text-3'}`}>{unit}</span>
        </p>
        <p className={`text-13 ${ink ? 'text-on-ink-2' : 'text-text-3'}`}>{note}</p>
      </div>
      <ul className="flex flex-col gap-10">
        {plan.features.map((feature) => (
          <li key={feature} className="text-14 flex gap-8">
            <Icon
              name="check"
              className={`mt-2 size-16 shrink-0 ${ink ? 'text-on-ink-accent' : 'text-accent-ink'}`}
            />
            {feature}
          </li>
        ))}
      </ul>
      {plan.start === 'admin' && <AdminLink label={START_LABEL} className={button} />}
      {plan.start === 'choose' && (
        <ExternalLink href={CONTACT_URL} className={button}>
          {`Choose ${plan.name}`}
        </ExternalLink>
      )}
    </li>
  );
}
