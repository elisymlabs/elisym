import { useState } from 'react';
import { CONVERSATION_DEFINITION, PLANS } from '../constants';
import { type Billing, BillingSwitch } from './BillingSwitch';
import { Eyebrow } from './Eyebrow';
import { PlanCard } from './PlanCard';
import { Reveal } from './Reveal';

export function Pricing() {
  // Monthly first: the price a store pays without committing to a year.
  const [billing, setBilling] = useState<Billing>('monthly');
  const selfServe = PLANS.filter((plan) => plan.price.kind === 'flat');
  const contract = PLANS.filter((plan) => plan.price.kind === 'from');
  return (
    <section id="pricing" className="mx-auto max-w-1440 px-12 py-96 sm:px-24 sm:py-160">
      <Reveal className="mx-auto flex max-w-800 flex-col items-center gap-20 text-center">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
          Pay for conversations, <em>not seats.</em>
        </h2>
        <p className="text-18 text-text-2 max-w-600 leading-relaxed">
          Start free and move up as your store grows. Every plan has every product source and every
          language.
        </p>
      </Reveal>
      <Reveal delay={1} className="mt-40">
        <BillingSwitch value={billing} onChange={setBilling} />
      </Reveal>
      <Reveal delay={1}>
        <ul className="mt-48 grid items-stretch gap-12 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {selfServe.map((plan) => (
            <PlanCard key={plan.name} plan={plan} billing={billing} />
          ))}
        </ul>
        <ul className="mt-12 grid">
          {contract.map((plan) => (
            <PlanCard key={plan.name} plan={plan} billing={billing} wide />
          ))}
        </ul>
      </Reveal>
      <div className="text-13 text-text-3 mx-auto mt-32 flex max-w-760 flex-col gap-6 text-center leading-relaxed">
        <p>
          {`Conversation counts are approximate. ${CONVERSATION_DEFINITION} Each plan has a monthly spend cap, so heavy use pauses the chat before it can cost you more.`}
        </p>
        <p>Create your store in the admin, then message us on X and we put it on your plan.</p>
      </div>
    </section>
  );
}
