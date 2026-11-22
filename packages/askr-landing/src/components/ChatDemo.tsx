import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PRODUCT_NAME } from '../constants';
import type { Niche, Turn } from '../niches';
import { prefersReducedMotion, useInView } from '../useInView';
import { WIDGET_TEXT } from '../widget-text';
import { DemoTips } from './DemoTips';
import { LiveMark } from './LiveMark';
import { WidgetCard } from './WidgetCard';
import { WidgetComparison } from './WidgetComparison';
import { WidgetPanel } from './WidgetPanel';

/**
 * Each turn as the widget plays it, phase by phase: a pause (the greeting before the first
 * question; a chip being tapped before a later one), the question rising in, "Thinking..." on the
 * status line, the whole answer with its chips, then its cards or comparison a moment later (the
 * widget resolves them from its catalog after the answer lands), then a pause to read.
 */
const PAUSE = 0;
const ASKED = 1;
const THINKING = 2;
const ANSWERED = 3;
const SHOWN = 4;

/** How long each phase stays, the reading pause aside. */
const PHASE_MS = [900, 450, 1900, 160] as const;
/** A tapped chip stays pressed this long before its question goes out. */
const TAP_MS = 650;
/** Time to read an answer before the visitor taps the next chip. */
const READ_MS = 3400;
/** Time to read the finished conversation before the next store comes. */
const FINAL_READ_MS = 6500;

interface Step {
  turn: number;
  phase: number;
  ms: number;
}

/** The whole conversation as a list of steps, one per phase of each turn. */
function stepsOf(turns: readonly Turn[]): Step[] {
  return turns.flatMap((_turn, turnIndex) => {
    const last = turnIndex === turns.length - 1;
    return [
      { turn: turnIndex, phase: PAUSE, ms: turnIndex === 0 ? PHASE_MS[PAUSE] : TAP_MS },
      { turn: turnIndex, phase: ASKED, ms: PHASE_MS[ASKED] },
      { turn: turnIndex, phase: THINKING, ms: PHASE_MS[THINKING] },
      { turn: turnIndex, phase: ANSWERED, ms: PHASE_MS[ANSWERED] },
      { turn: turnIndex, phase: SHOWN, ms: last ? FINAL_READ_MS : READ_MS },
    ];
  });
}

/** What a screen reader hears: the whole conversation, as the drawing ends up showing it. */
function describe(niche: Niche): string {
  const turns = niche.turns.map((turn, index) => {
    const asks = index === 0 ? 'asks' : 'taps';
    const parts = [`A visitor ${asks}: ${turn.question}`, `The assistant answers: ${turn.answer}`];
    if (turn.cards !== undefined && turn.cards.length > 0) {
      const shown = turn.cards.map((card) => `${card.product.title} at ${card.product.price}`);
      parts.push(`It shows ${shown.join(' and ')}.`);
    }
    if (turn.comparison !== undefined) {
      const compared = turn.comparison.products.map((product) => product.title);
      parts.push(`It compares ${compared.join(', ')} side by side.`);
    }
    return parts.join(' ');
  });
  return `The ${PRODUCT_NAME} chat on ${niche.store}'s site. ${turns.join(' ')}`;
}

interface Props {
  niche: Niche;
  /**
   * Called once the conversation has played through (and again whenever it is set while the
   * conversation is finished). Without it the finished conversation stays: it plays only once.
   */
  onFinished?: () => void;
  className?: string;
}

/** The widget answering a visitor, played once it is on screen: nothing in it is live. */
export function ChatDemo({ niche, onFinished, className = '' }: Props) {
  const [ref, inView] = useInView<HTMLElement>(0.3);
  const logRef = useRef<HTMLDivElement>(null);
  const steps = useMemo(() => stepsOf(niche.turns), [niche.turns]);
  const final = steps.length - 1;
  const [step, setStep] = useState(0);
  const [still] = useState(prefersReducedMotion);
  const finished = useRef(onFinished);
  // Only the finished conversation waits on whether it may hand on; earlier steps never do, so a
  // pointer crossing the store's edge mid-conversation does not restart a step.
  const handOn = step === final ? onFinished !== undefined : undefined;
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    // Played once: a finished conversation waits for someone to move on, and never replays.
    if (!inView || still || handOn === false) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (step === final) {
        finished.current?.();
        return;
      }
      setStep((current) => current + 1);
    }, steps[step]?.ms ?? 1000);
    return () => clearTimeout(timer);
  }, [inView, still, step, handOn, final, steps]);

  const shown = still ? final : step;
  const now = steps[shown] ?? { turn: 0, phase: PAUSE, ms: 0 };
  const phaseOf = (turn: number) => {
    if (turn < now.turn) {
      return SHOWN;
    }
    return turn === now.turn ? now.phase : -1;
  };
  // The chips under the newest answer; while one is being tapped, the previous answer's. Once a
  // question goes out they go, until its answer brings new ones.
  const chipsTurn = now.phase >= ANSWERED ? now.turn : now.turn - 1;
  const chips =
    now.phase >= ANSWERED || now.phase === PAUSE ? (niche.turns[chipsTurn]?.chips ?? []) : [];
  const tapped = now.phase === PAUSE && now.turn > 0 ? niche.turns[now.turn]?.question : undefined;
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
    <figure ref={ref} aria-label={describe(niche)} className={className}>
      <DemoTips>
        <WidgetPanel
          name={niche.store}
          logRef={logRef}
          status={
            now.phase === THINKING ? (
              <>
                <LiveMark className="-mt-2 size-24 flex-none" />
                <span>{WIDGET_TEXT.thinking}</span>
              </>
            ) : undefined
          }
          chips={chips}
          pressedChip={tapped}
          className="wgt-panel-in h-[min(600px,calc(100vh-32px))] w-full"
        >
          <div className="contents">
            <p className="wgt-theirs wgt-rise">{WIDGET_TEXT.greeting}</p>
            {niche.turns.map((turn, index) => (
              <ChatTurn key={index} turn={turn} phase={phaseOf(index)} />
            ))}
          </div>
        </WidgetPanel>
      </DemoTips>
    </figure>
  );
}

interface TurnProps {
  turn: Turn;
  /** How far this turn has played: before ASKED nothing of it shows. */
  phase: number;
}

/** One question and its answer, as far as the conversation has played it. */
function ChatTurn({ turn, phase }: TurnProps) {
  return (
    <>
      {phase >= ASKED && <p className="wgt-mine wgt-rise">{turn.question}</p>}
      {phase >= ANSWERED && <p className="wgt-theirs wgt-rise">{turn.answer}</p>}
      {phase >= SHOWN && turn.cards !== undefined && (
        <div className="wgt-cards">
          {turn.cards.map((card) => (
            <WidgetCard key={card.product.title} product={card.product} reason={card.reason} />
          ))}
        </div>
      )}
      {phase >= SHOWN && turn.comparison !== undefined && (
        <WidgetComparison comparison={turn.comparison} className="wgt-rise" />
      )}
    </>
  );
}
