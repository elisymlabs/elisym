import { useEffect, useState } from 'react';
import { PRODUCTS } from '../media';
import { prefersReducedMotion, useInView } from '../useInView';
import { Icon } from './Icon';
import { WidgetCard } from './WidgetCard';

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
      aria-label={`The model drafts a price of $149. The check finds no such price in the catalog, and the visitor sees the headphones with their catalog price, ${PRODUCTS.headphonesBlack.price}.`}
      className="flex flex-col gap-16"
    >
      <div aria-hidden="true" className="flex flex-col gap-10">
        <span className="text-11 text-on-ink-2 font-semibold tracking-[0.14em] uppercase">
          The model drafts
        </span>
        <p className="border-ink-line text-on-ink border-l-2 pl-16 font-serif text-[clamp(1.75rem,3vw,2.75rem)] leading-[1.1]">
          The Pulse Pro is{' '}
          <span data-struck={shown >= 1} className={`strike ${shown >= 1 ? 'text-[#f97066]' : ''}`}>
            $149
          </span>{' '}
          today.
        </p>
      </div>
      <p
        aria-hidden="true"
        className={`text-13 flex items-center gap-10 self-start rounded-full border px-14 py-8 transition duration-500 ${shown >= 2 ? 'border-on-ink/40 text-on-ink opacity-100' : 'border-ink-line text-on-ink-2 opacity-50'}`}
      >
        <Icon name="shield" className="size-16 shrink-0" />
        {shown >= 2
          ? '$149 is not in the catalog. Rewritten before sending.'
          : 'Checking every price against the catalog'}
      </p>
      <div
        aria-hidden="true"
        className={`transition duration-500 ${shown >= 3 ? 'opacity-100' : 'opacity-0'}`}
      >
        <span className="text-11 text-on-ink-2 font-semibold tracking-[0.14em] uppercase">
          The visitor sees
        </span>
        <div className="wgt wgt-panel mt-10 max-w-380">
          <div className="wgt-log">
            <p className="wgt-theirs">
              The Pulse Pro fits what you asked for: 40 hours on a charge.
            </p>
            <div className="wgt-cards">
              <WidgetCard product={PRODUCTS.headphonesBlack} reason="Black, 40 h battery" />
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
