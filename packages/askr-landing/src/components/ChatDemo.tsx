import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PRODUCT_NAME } from '../constants';
import type { Niche } from '../niches';
import { prefersReducedMotion, useInView } from '../useInView';
import { WIDGET_TEXT } from '../widget-text';
import { LiveMark } from './LiveMark';
import { WidgetCard } from './WidgetCard';
import { WidgetPanel } from './WidgetPanel';

/**
 * The conversation as the widget plays it, step by step: the greeting, the question rising in,
 * "Thinking..." on the status line, the whole answer with its chips, then its cards a moment
 * later (the widget resolves them from its catalog after the answer lands), then a pause.
 */
const STEPS = [
  { name: 'greeting', ms: 900 },
  { name: 'asked', ms: 450 },
  { name: 'thinking', ms: 1900 },
  { name: 'answered', ms: 160 },
  { name: 'cards', ms: 6500 },
] as const;

const ASKED = 1;
const THINKING = 2;
const ANSWERED = 3;
const FINAL = STEPS.length - 1;

interface Props {
  niche: Niche;
  /** Called once the conversation has played through; without it, it plays again. */
  onFinished?: () => void;
  className?: string;
}

/** The widget answering a visitor, played once it is on screen: nothing in it is live. */
export function ChatDemo({ niche, onFinished, className = '' }: Props) {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const logRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [still] = useState(prefersReducedMotion);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!inView || still) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (step === FINAL && finished.current !== undefined) {
        finished.current();
        return;
      }
      setStep((current) => (current === FINAL ? 0 : current + 1));
    }, STEPS[step]?.ms ?? 1000);
    return () => clearTimeout(timer);
  }, [inView, still, step]);

  const shown = still ? FINAL : step;
  // When the conversation grows it moves to the newest message: the widget jumps there, the
  // drawing glides, unless the visitor asked for less motion.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log === null) {
      return;
    }
    if (shown === 0 || still || typeof log.scrollTo !== 'function') {
      log.scrollTop = shown === 0 ? 0 : log.scrollHeight;
      return;
    }
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }, [shown, still]);

  return (
    <figure
      ref={ref}
      aria-label={`The ${PRODUCT_NAME} chat on ${niche.store}'s site. A visitor asks: ${niche.question} The assistant answers: ${niche.answer} It shows ${niche.cards.map((card) => `${card.product.title} at ${card.product.price}`).join(' and ')}.`}
      className={className}
    >
      <WidgetPanel
        name={niche.store}
        logRef={logRef}
        status={
          shown === THINKING ? (
            <>
              <LiveMark className="-mt-2 size-24 flex-none" />
              <span>{WIDGET_TEXT.thinking}</span>
            </>
          ) : undefined
        }
        chips={shown >= ANSWERED ? niche.chips : []}
        className="wgt-panel-in h-[min(600px,calc(100vh-32px))] w-full"
      >
        <div aria-hidden="true" className="contents">
          <p className="wgt-theirs wgt-rise">{WIDGET_TEXT.greeting}</p>
          {shown >= ASKED && <p className="wgt-mine wgt-rise">{niche.question}</p>}
          {shown >= ANSWERED && <p className="wgt-theirs wgt-rise">{niche.answer}</p>}
          {shown === FINAL && (
            <div className="wgt-cards">
              {niche.cards.map((card) => (
                <WidgetCard key={card.product.title} product={card.product} reason={card.reason} />
              ))}
            </div>
          )}
        </div>
      </WidgetPanel>
    </figure>
  );
}
