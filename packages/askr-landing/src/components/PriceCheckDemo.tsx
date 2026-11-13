import { useEffect, useState } from 'react';
import { PRODUCTS } from '../media';
import { prefersReducedMotion, useInView } from '../useInView';
import { Icon } from './Icon';
import { ProductCard } from './ProductCard';

/** Steps of the check, with how long each one holds before the next. */
const STEPS = [
  { name: 'draft', ms: 1600 },
  { name: 'struck', ms: 1100 },
  { name: 'caught', ms: 1300 },
  { name: 'rewritten', ms: 6000 },
] as const;

const FINAL = STEPS.length - 1;

/** A wrong price stopped before the visitor sees it, played on a loop once on screen. */
export function PriceCheckDemo() {
  const [ref, inView] = useInView<HTMLElement>(0.4);
  const [step, setStep] = useState(0);
  const [still] = useState(prefersReducedMotion);

  useEffect(() => {
    if (!inView || still) {
      return undefined;
    }
    const timer = setTimeout(
      () => setStep((current) => (current + 1) % STEPS.length),
      STEPS[step]?.ms ?? 1000,
    );
    return () => clearTimeout(timer);
  }, [inView, still, step]);

  const shown = still ? FINAL : step;
  return (
    <figure
      ref={ref}
      aria-label="The model drafts a price of $149. The check finds no such price in the catalog, and the visitor sees the headphones with their catalog price, $199.00."
      className="rounded-32 border-ink-line bg-ink-2 flex flex-col gap-16 border p-20 sm:p-28"
    >
      <div aria-hidden="true" className="flex flex-col gap-8">
        <span className="text-11 text-on-ink-2 font-semibold tracking-[0.14em] uppercase">
          The model drafts
        </span>
        <p className="bg-ink text-15 text-on-ink rounded-bl-6 rounded-[18px] px-16 py-12 leading-relaxed">
          The Pulse Pro is{' '}
          <span data-struck={shown >= 1} className={`strike ${shown >= 1 ? 'text-[#f0a37d]' : ''}`}>
            $149
          </span>{' '}
          today.
        </p>
      </div>
      <p
        aria-hidden="true"
        className={`text-13 flex items-center gap-10 rounded-full border px-14 py-8 transition duration-500 ${shown >= 2 ? 'border-on-ink-accent/50 text-on-ink-accent opacity-100' : 'border-ink-line text-on-ink-2 opacity-40'}`}
      >
        <Icon name="shield" className="size-16 shrink-0" />
        {shown >= 2
          ? '$149 is not in the catalog. Rewritten before sending.'
          : 'Checking every price against the catalog'}
      </p>
      <div
        aria-hidden="true"
        className={`flex flex-col gap-8 transition duration-500 ${shown >= 3 ? 'opacity-100' : 'opacity-0'}`}
      >
        <span className="text-11 text-on-ink-2 font-semibold tracking-[0.14em] uppercase">
          The visitor sees
        </span>
        <p className="bg-ink text-15 text-on-ink rounded-bl-6 rounded-[18px] px-16 py-12 leading-relaxed">
          The Pulse Pro fits what you asked for: 40 hours on a charge.
        </p>
        {shown >= 3 && (
          <div className="arrive">
            <ProductCard product={PRODUCTS.headphonesBlack} />
          </div>
        )}
      </div>
    </figure>
  );
}
