import { EVALS, PRODUCT_NAME } from '../constants';
import { SectionHeading } from './SectionHeading';

const STATS = [
  {
    value: EVALS.passed,
    label: `of ${EVALS.scenarios} test conversations passed`,
    note: 'Budgets, comparisons, policies, tricky prices, injected instructions and questions it must not answer.',
  },
  {
    value: '< 1¢',
    label: 'per conversation',
    note: 'A fraction of a cent of model cost for a whole conversation that got its answer.',
  },
  {
    value: `~${EVALS.medianAnswer}`,
    label: 'median answer',
    note: 'Including the search through your catalog and the price check.',
  },
];

export function Numbers() {
  return (
    <section id="numbers" className="border-line bg-surface border-y">
      <div className="mx-auto max-w-1200 px-16 py-80 sm:px-24 sm:py-112">
        <SectionHeading eyebrow="Tested" title="Measured, not promised">
          {`We grade ${PRODUCT_NAME} on a fixed set of ${EVALS.scenarios} test conversations with a sample store. These are the numbers of the default model.`}
        </SectionHeading>
        <dl className="mt-48 grid gap-16 md:grid-cols-3">
          {STATS.map((stat) => (
            <div
              key={stat.label}
              className="rounded-24 border-line bg-bg flex flex-col gap-8 border p-28"
            >
              <dt className="text-15 text-text-2 order-2 font-medium">{stat.label}</dt>
              <dd className="text-48 text-accent-ink order-1 leading-none font-semibold tracking-tight">
                {stat.value}
              </dd>
              <dd className="text-14 text-text-3 order-3 leading-relaxed">{stat.note}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
