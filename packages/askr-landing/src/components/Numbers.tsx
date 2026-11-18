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
    <section id="numbers" className="mx-auto max-w-1440 px-16 py-120 sm:px-32 sm:py-200">
      <Reveal className="flex flex-col gap-20">
        <Eyebrow>Measured, not promised</Eyebrow>
        <h2 className="max-w-900 font-serif text-[clamp(2.25rem,4.4vw,4.5rem)] leading-[1] tracking-[-0.02em]">
          {`We grade ${PRODUCT_NAME} on a fixed set of test conversations with a sample store.`}
        </h2>
      </Reveal>
      <dl className="mt-64 flex flex-col">
        {STATS.map((stat) => (
          <Reveal
            key={stat.label}
            className="border-text grid items-end gap-x-48 gap-y-8 border-t py-24 sm:py-32 lg:grid-cols-[1.4fr_1fr]"
          >
            <dd className="font-serif text-[clamp(5.5rem,15vw,15rem)] leading-[0.8] tracking-[-0.04em] tabular-nums lg:row-span-2">
              {stat.value}
            </dd>
            <dt className="text-20 self-end font-medium">{stat.label}</dt>
            <dd className="text-15 text-text-2 max-w-440 pb-8 leading-relaxed">{stat.note}</dd>
          </Reveal>
        ))}
      </dl>
    </section>
  );
}
