import { useEffect, useRef, useState } from 'react';
import { PRODUCT_NAME } from '../constants';
import type { Niche } from '../niches';
import { prefersReducedMotion, useInView } from '../useInView';
import { WIDGET_TEXT } from '../widget-text';
import { LiveMark } from './LiveMark';
import { WidgetCard } from './WidgetCard';
import { WidgetPanel } from './WidgetPanel';

/** How long each step of the conversation holds before the next, by step. */
function stepMs(step: number, answer: string): number {
  return [700, 900, 1500, answer.length * 10 + 250, 350, 5600][step] ?? 1000;
}

const FINAL = 5;

interface Props {
  niche: Niche;
  /** Called once the conversation has played through; without it, it plays again. */
  onFinished?: () => void;
  className?: string;
}

/** The widget answering a visitor, played once it is on screen: nothing in it is live. */
export function ChatDemo({ niche, onFinished, className = '' }: Props) {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(0);
  const [still] = useState(prefersReducedMotion);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!inView || still) {
      return undefined;
    }
    const timer = setTimeout(
      () => {
        if (step === FINAL && finished.current !== undefined) {
          finished.current();
          return;
        }
        setTyped(0);
        setStep((current) => (current === FINAL ? 1 : current + 1));
      },
      stepMs(step, niche.answer),
    );
    return () => clearTimeout(timer);
  }, [inView, still, step, niche.answer]);

  const shown = still ? FINAL : step;
  const answering = shown === 3 && !still;
  useEffect(() => {
    if (!answering) {
      return undefined;
    }
    const timer = setInterval(
      () => setTyped((count) => Math.min(niche.answer.length, count + 2)),
      20,
    );
    return () => clearInterval(timer);
  }, [answering, niche.answer.length]);

  const answer = answering ? niche.answer.slice(0, typed) : niche.answer;
  return (
    <figure
      ref={ref}
      aria-label={`The ${PRODUCT_NAME} chat on ${niche.store}'s site. A visitor asks: ${niche.question} The assistant answers: ${niche.answer} It shows ${niche.cards.map((card) => `${card.product.title} at ${card.product.price}`).join(' and ')}.`}
      className={className}
    >
      <WidgetPanel
        name={niche.store}
        chips={shown === FINAL ? niche.chips : []}
        className="h-[600px] w-full"
      >
        <div aria-hidden="true" className="contents">
          <p className="wgt-theirs">{WIDGET_TEXT.greeting}</p>
          {shown >= 1 && <p className="wgt-mine arrive">{niche.question}</p>}
          {shown === 2 && (
            <p className="wgt-muted arrive flex items-center gap-8 text-[12.5px]">
              <LiveMark className="-mt-2 size-24 flex-none" />
              Thinking...
            </p>
          )}
          {shown >= 3 && <p className="wgt-theirs">{answer}</p>}
          {shown >= 4 && (
            <div className="wgt-cards">
              {niche.cards.map((card, index) => (
                <WidgetCard
                  key={card.product.title}
                  product={card.product}
                  reason={card.reason}
                  className={`arrive ${index === 1 ? '[animation-delay:80ms]' : ''}`}
                />
              ))}
            </div>
          )}
        </div>
      </WidgetPanel>
    </figure>
  );
}
