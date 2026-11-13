import { PLANS, type Plan, X_URL } from '../constants';
import { AdminLink } from './AdminLink';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

const BUTTON = 'rounded-12 text-15 mt-auto block px-16 py-12 text-center font-semibold transition';
const PRIMARY = `${BUTTON} bg-accent text-accent-text hover:brightness-95`;
const SECONDARY = `${BUTTON} border-line-2 hover:bg-surface-2 border`;

interface Props {
  plan: Plan;
}

function PlanCard({ plan }: Props) {
  const button = plan.featured ? PRIMARY : SECONDARY;
  return (
    <li
      className={`rounded-24 bg-surface relative flex flex-col gap-20 border p-24 ${plan.featured ? 'border-accent shadow-accent/10 shadow-2xl' : 'border-line'}`}
    >
      {plan.featured && (
        <span className="bg-accent text-12 text-accent-text absolute -top-12 left-24 rounded-full px-10 py-4 font-semibold">
          Most popular
        </span>
      )}
      <div className="flex flex-col gap-6">
        <h3 className="text-18 font-semibold">{plan.name}</h3>
        <p className="text-14 text-text-2 lg:min-h-44">{plan.blurb}</p>
      </div>
      <p className="flex items-baseline gap-6">
        <span className="text-40 leading-none font-semibold tracking-tight">
          {plan.price ?? 'Custom'}
        </span>
        {plan.price !== undefined && <span className="text-14 text-text-3">/ month</span>}
      </p>
      <ul className="flex flex-col gap-10">
        {plan.features.map((feature) => (
          <li key={feature} className="text-14 flex gap-8">
            <Icon name="check" className="text-accent-ink mt-2 size-16 shrink-0" />
            {feature}
          </li>
        ))}
      </ul>
      {plan.start === 'admin' ? (
        <AdminLink label="Start free" className={button} />
      ) : (
        <ExternalLink href={X_URL} className={button}>
          {plan.price === undefined ? 'Talk to us' : `Choose ${plan.name}`}
        </ExternalLink>
      )}
    </li>
  );
}

export function Pricing() {
  return (
    <section id="pricing" className="border-line bg-surface/40 border-y">
      <div className="mx-auto max-w-1280 px-16 py-80 sm:px-24 sm:py-112">
        <SectionHeading eyebrow="Pricing" title="Pay for conversations, not seats" centered>
          A conversation is one visitor's chat that got an answer, up to 24 hours long, however many
          questions it holds.
        </SectionHeading>
        <ul className="mt-56 grid gap-16 sm:grid-cols-2 lg:grid-cols-5">
          {PLANS.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </ul>
        <p className="text-14 text-text-3 mt-24 text-center">
          Create your store in the admin, then message us on X and we put it on your plan.
        </p>
      </div>
    </section>
  );
}
