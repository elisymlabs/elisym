import { BUTTON } from '../buttons';
import { CONTACT_URL, type ContractPlan } from '../constants';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';

interface Props {
  plan: ContractPlan;
}

/** The plan priced by agreement, across the row under the cards: who it is for, from what, what it adds. */
export function EnterpriseRow({ plan }: Props) {
  return (
    <li className="rounded-32 border-line bg-surface grid gap-28 border p-24 sm:p-32 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,2fr)_auto] lg:items-center lg:gap-40">
      <div className="flex flex-col gap-14">
        <div className="flex flex-col gap-4">
          <h3 className="text-28 font-serif">{plan.name}</h3>
          <p className="text-14 text-text-2">{plan.blurb}</p>
        </div>
        <div className="flex flex-col gap-4">
          <p className="flex items-baseline gap-6">
            <span className="text-14 text-text-3">from</span>
            <span className="text-40 font-serif leading-none tabular-nums">
              {plan.price.monthly}
            </span>
            <span className="text-14 text-text-3">/ month</span>
          </p>
          <p className="text-13 text-text-3">Monthly subscription, terms by agreement</p>
        </div>
      </div>
      <ul className="border-line grid gap-x-32 gap-y-12 sm:grid-cols-2 lg:border-l lg:pl-40">
        {plan.features.map((feature) => (
          <li key={feature} className="text-14 flex gap-8">
            <Icon name="check" className="text-accent-ink mt-2 size-16 shrink-0" />
            {feature}
          </li>
        ))}
      </ul>
      <ExternalLink href={CONTACT_URL} className={`${BUTTON.solid} lg:self-center`}>
        Contact us
        <Icon name="arrow" className="size-18" />
      </ExternalLink>
    </li>
  );
}
