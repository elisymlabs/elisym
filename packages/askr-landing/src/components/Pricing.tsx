import { useState } from 'react';
import {
  CHOOSE_PLAN_TEXT,
  PLANS,
  PRICING_SMALL_PRINT,
  isContractPlan,
  isFlatPlan,
} from '../constants';
import { type Billing, BillingSwitch } from './BillingSwitch';
import { EnterpriseRow } from './EnterpriseRow';
import { Eyebrow } from './Eyebrow';
import { PlanCard } from './PlanCard';
import { Reveal } from './Reveal';
import { SizedPlanCard } from './SizedPlanCard';

export function Pricing() {
  // Yearly first: the lower price per month, with the yearly total under it.
  const [billing, setBilling] = useState<Billing>('yearly');
  const selfServe = PLANS.filter(isFlatPlan);
  const sizes = selfServe.filter((plan) => plan.group === 'sizes');
  const contract = PLANS.filter(isContractPlan);
  return (
    <section
      aria-labelledby="pricing-title"
      className="mx-auto max-w-1440 px-12 py-96 sm:px-24 sm:py-160"
    >
      <Reveal className="mx-auto flex max-w-800 flex-col items-center gap-20 text-center">
        <Eyebrow>Pricing</Eyebrow>
        <h2 id="pricing-title" className="text-48 sm:text-80 font-serif leading-[0.95]">
          Pay for conversations, <em>not seats.</em>
        </h2>
        <p className="text-18 text-text-2 max-w-600 leading-relaxed">
          Start free and move up as your store grows. Every plan has every product source and every
          language.
        </p>
      </Reveal>
      {/* #pricing lands on the plans, the billing switch just under the header. */}
      <div id="pricing">
        <Reveal delay={1} className="mt-40">
          <BillingSwitch value={billing} onChange={setBilling} />
        </Reveal>
        <Reveal delay={1}>
          <ul className="mx-auto mt-48 grid max-w-1200 items-stretch gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {selfServe
              .filter((plan) => plan.group === undefined)
              .map((plan) => (
                <PlanCard key={plan.name} plan={plan} billing={billing} />
              ))}
            {sizes.length > 0 && <SizedPlanCard plans={sizes} billing={billing} />}
          </ul>
          <ul className="mx-auto mt-12 grid max-w-1200">
            {contract.map((plan) => (
              <EnterpriseRow key={plan.name} plan={plan} />
            ))}
          </ul>
        </Reveal>
        <div className="text-13 text-text-3 mx-auto mt-32 flex max-w-760 flex-col gap-6 text-center leading-relaxed">
          <p>{PRICING_SMALL_PRINT}</p>
          <p>{CHOOSE_PLAN_TEXT}</p>
        </div>
      </div>
    </section>
  );
}
