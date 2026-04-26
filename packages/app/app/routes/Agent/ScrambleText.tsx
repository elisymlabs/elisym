/* cspell:disable */
import { useState, useEffect, type CSSProperties } from 'react';

const SCRAMBLE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アイウエオカキクケコサシスセソタチツテトабвгдежзийклмнопрстуфхцчшщ#@$%&*+=<>?/\\';
/* cspell:enable */

const LOOP_PAUSE_MS = 1000;

interface Props {
  text: string;
  duration?: number;
  className?: string;
  style?: CSSProperties;
}

export function ScrambleText({ text, duration = 1000, className, style }: Props) {
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    let raf = 0;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    const runCycle = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / duration);
        const revealed = Math.floor(progress * text.length);
        let out = '';
        for (let i = 0; i < text.length; i++) {
          if (i < revealed || text[i] === ' ' || text[i] === '.') {
            out += text[i];
          } else {
            out += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          }
        }
        setDisplay(out);
        if (progress < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          setDisplay(text);
          pauseTimer = setTimeout(runCycle, LOOP_PAUSE_MS);
        }
      };
      raf = requestAnimationFrame(tick);
    };
    runCycle();
    return () => {
      cancelAnimationFrame(raf);
      if (pauseTimer) {
        clearTimeout(pauseTimer);
      }
    };
  }, [text, duration]);

  return (
    <span className={className} style={style}>
      {display}
    </span>
  );
}
