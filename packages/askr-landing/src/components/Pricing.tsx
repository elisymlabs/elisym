import { BUTTON } from '../buttons';
import { PLANS, type Plan, X_URL } from '../constants';
import { AdminLink } from './AdminLink';
import { ExternalLink } from './ExternalLink';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

interface Props {
  plan: Plan;
}

function PlanCard({ plan }: Props) {
  const ink = plan.featured;
  const button = `${ink ? BUTTON.light : BUTTON.ghost} mt-auto w-full`;
  return (
    <li
      className={`rounded-32 relative flex flex-col gap-24 border p-24 ${ink ? 'bg-ink text-on-ink border-ink shadow-[0_40px_80px_-30px_rgb(23_21_15_/_0.5)] lg:-my-16 lg:py-40' : 'bg-surface border-line'}`}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-8">
          <h3 className="text-28 font-serif">{plan.name}</h3>
          {ink && (
            <span className="bg-on-ink-accent text-11 text-ink rounded-full px-10 py-4 font-semibold">
              Most popular
            </span>
          )}
        </div>
        <p className={`text-14 lg:min-h-44 ${ink ? 'text-on-ink-2' : 'text-text-2'}`}>
          {plan.blurb}
        </p>
      </div>
      <p className="flex items-baseline gap-6">
        <span className="text-56 font-serif leading-none tabular-nums">
          {plan.price ?? 'Custom'}
        </span>
        {plan.price !== undefined && (
          <span className={`text-14 ${ink ? 'text-on-ink-2' : 'text-text-3'}`}>/ month</span>
        )}
      </p>
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
    <section id="pricing" className="mx-auto max-w-1360 px-12 py-96 sm:px-24 sm:py-160">
      <Reveal className="mx-auto flex max-w-800 flex-col items-center gap-20 text-center">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
          Pay for conversations, <em>not seats.</em>
        </h2>
        <p className="text-18 text-text-2 max-w-600 leading-relaxed">
          A conversation is one visitor's chat that got an answer, up to 24 hours long, however many
          questions it holds.
        </p>
      </Reveal>
      <Reveal delay={1}>
        <ul className="mt-64 grid items-stretch gap-12 sm:grid-cols-2 lg:grid-cols-5">
          {PLANS.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </ul>
      </Reveal>
      <p className="text-14 text-text-3 mt-32 text-center">
        Create your store in the admin, then message us on X and we put it on your plan.
      </p>
    </section>
  );
}
