import { EVALS, PRODUCT_NAME } from '../constants';
import { Eyebrow } from './Eyebrow';
import { Reveal } from './Reveal';

const STATS = [
  {
    value: EVALS.passed,
    label: `of ${EVALS.scenarios} graded test conversations passed by the default model`,
    note: 'Budgets, comparisons, policies, tricky prices, injected instructions and questions it must not answer.',
  },
  {
    value: '<1¢',
    label: 'per conversation',
    note: 'A fraction of a cent of model cost for a whole conversation that got its answer.',
  },
  {
    value: '24 h',
    label: 'the longest a conversation lives',
    note: 'Then it is gone. There is no transcript archive, for us or for you.',
  },
];

export function Numbers() {
  return (
    <section id="numbers" className="border-line-2 border-y">
      <div className="mx-auto max-w-1200 px-16 py-96 sm:px-24 sm:py-128">
        <Reveal className="flex flex-col gap-16">
          <Eyebrow>Measured, not promised</Eyebrow>
          <h2 className="text-40 sm:text-56 max-w-800 font-serif leading-[1.02]">
            {`We grade ${PRODUCT_NAME} on a fixed set of test conversations with a sample store.`}
          </h2>
        </Reveal>
        <Reveal delay={1}>
          <dl className="mt-56 grid md:grid-cols-3">
            {STATS.map((stat, index) => (
              <div
                key={stat.label}
                className={`border-line-2 flex flex-col gap-10 border-t py-28 md:border-t-0 md:py-0 ${index > 0 ? 'md:border-l md:pl-32' : ''} ${index < STATS.length - 1 ? 'md:pr-32' : ''}`}
              >
                <dt className="text-16 order-2 font-medium">{stat.label}</dt>
                <dd className="text-80 sm:text-96 text-accent-ink order-1 font-serif leading-none tabular-nums">
                  {stat.value}
                </dd>
                <dd className="text-14 text-text-2 order-3 leading-relaxed">{stat.note}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
