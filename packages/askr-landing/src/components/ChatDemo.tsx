import { useEffect, useState } from 'react';
import { PRODUCT_NAME } from '../constants';
import { PRODUCTS } from '../media';
import { prefersReducedMotion, useInView } from '../useInView';
import { AskrMark } from './AskrMark';
import { Icon } from './Icon';
import { ProductCard } from './ProductCard';

const QUESTION = 'A warm sweater under $80 that ships to Spain?';
const ANSWER = "Two fit. Both ship to Spain in 3 to 5 days, as the store's shipping policy says.";
const CARDS = [PRODUCTS.sweater, PRODUCTS.cardigan];

/** Steps of the conversation, with how long each one holds before the next. */
const STEPS = [
  { name: 'empty', ms: 600 },
  { name: 'asked', ms: 700 },
  { name: 'typing', ms: 1100 },
  { name: 'answering', ms: ANSWER.length * 22 + 200 },
  { name: 'card-1', ms: 350 },
  { name: 'card-2', ms: 7000 },
] as const;

const FINAL = STEPS.length - 1;

/** The widget answering a visitor, played on a loop once it is on screen: nothing in it is live. */
export function ChatDemo() {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(0);
  const [still] = useState(prefersReducedMotion);

  useEffect(() => {
    if (!inView || still) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setTyped(0);
      setStep((current) => (current + 1) % STEPS.length);
    }, STEPS[step]?.ms ?? 1000);
    return () => clearTimeout(timer);
  }, [inView, still, step]);

  const shown = still ? FINAL : step;
  const answering = shown === 3 && !still;
  useEffect(() => {
    if (!answering) {
      return undefined;
    }
    const timer = setInterval(() => setTyped((count) => Math.min(ANSWER.length, count + 1)), 22);
    return () => clearInterval(timer);
  }, [answering]);

  const answer = answering ? ANSWER.slice(0, typed) : ANSWER;
  return (
    <figure
      ref={ref}
      aria-label={`The ${PRODUCT_NAME} chat on a store's page: a visitor asks for ${QUESTION.toLowerCase()} The assistant answers: ${ANSWER}`}
      className="rounded-24 border-line bg-bg/95 w-full overflow-hidden border shadow-[0_30px_80px_-20px_rgb(23_21_15_/_0.35)] backdrop-blur"
    >
      <div className="border-line flex items-center gap-10 border-b px-16 py-12">
        <AskrMark className="size-28" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-14 font-semibold">Harbor Knits</span>
          <span className="text-12 text-text-3 flex items-center gap-6">
            <span className="bg-accent size-6 rounded-full" />
            AI assistant, online
          </span>
        </div>
        <Icon name="close" className="text-text-3 size-18" />
      </div>
      <div aria-hidden="true" className="flex min-h-340 flex-col gap-10 p-14">
        {shown >= 1 && (
          <p className="arrive bg-ink text-14 text-on-ink rounded-br-6 max-w-[85%] self-end rounded-[18px] px-14 py-10">
            {QUESTION}
          </p>
        )}
        {shown === 2 && (
          <p className="arrive bg-surface-2 rounded-bl-6 flex gap-4 self-start rounded-[18px] px-14 py-12">
            <span className="typing-dot bg-text-3 size-6 rounded-full" />
            <span className="typing-dot bg-text-3 size-6 rounded-full" />
            <span className="typing-dot bg-text-3 size-6 rounded-full" />
          </p>
        )}
        {shown >= 3 && (
          <p className="bg-surface-2 text-14 rounded-bl-6 max-w-[92%] self-start rounded-[18px] px-14 py-10 leading-relaxed">
            {answer}
          </p>
        )}
        {CARDS.map((product, index) =>
          shown >= 4 + index ? (
            <div key={product.title} className="arrive">
              <ProductCard product={product} />
            </div>
          ) : null,
        )}
      </div>
      <figcaption className="border-line text-12 text-text-3 flex items-center justify-between gap-12 border-t px-16 py-10">
        <span className="flex items-center gap-6">
          <Icon name="shield" className="text-accent-ink size-14" />
          Prices from the store's catalog
        </span>
        <span>by {PRODUCT_NAME}</span>
      </figcaption>
    </figure>
  );
}
