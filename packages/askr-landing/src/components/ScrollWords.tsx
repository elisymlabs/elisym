import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../useInView';

interface Props {
  text: string;
  /** Set after the lit text, in a quieter color, lighting last. */
  coda?: string;
  className?: string;
}

/**
 * A statement read as it scrolls: each word lights up as the block passes the middle of the
 * screen. Screen readers get the whole text at once; reduced motion shows it all lit.
 */
export function ScrollWords({ text, coda, className = '' }: Props) {
  const ref = useRef<HTMLParagraphElement>(null);
  const words = text.split(' ');
  const codaWords = coda === undefined ? [] : coda.split(' ');
  const total = words.length + codaWords.length;
  const [lit, setLit] = useState(() => (prefersReducedMotion() ? total : 0));

  useEffect(() => {
    const element = ref.current;
    if (element === null || prefersReducedMotion()) {
      return undefined;
    }
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const box = element.getBoundingClientRect();
      const start = window.innerHeight * 0.85;
      const end = window.innerHeight * 0.35;
      const progress = (start - box.top) / (start - end + box.height * 0.6);
      setLit(Math.round(Math.max(0, Math.min(1, progress)) * total));
    };
    const onScroll = () => {
      frame ??= requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [total]);

  return (
    <p ref={ref} className={className}>
      <span className="sr-only">{coda === undefined ? text : `${text} ${coda}`}</span>
      <span aria-hidden="true">
        {words.map((word, index) => (
          // A word's place in the statement is its identity: the text never reorders.
          // eslint-disable-next-line react/no-array-index-key
          <span key={index} className="lit-word" data-lit={index < lit}>
            {`${word} `}
          </span>
        ))}
        {codaWords.map((word, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <em key={index} className="lit-word text-text-3" data-lit={words.length + index < lit}>
            {`${word} `}
          </em>
        ))}
      </span>
    </p>
  );
}
