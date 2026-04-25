/* cspell:disable */
import { useState, useEffect, type CSSProperties } from 'react';

const SCRAMBLE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アイウエオカキクケコサシスセソタチツテトабвгдежзийклмнопрстуфхцчшщ#@$%&*+=<>?/\\';
/* cspell:enable */

interface Props {
  text: string;
  duration?: number;
  className?: string;
  style?: CSSProperties;
}

export function ScrambleText({ text, duration = 1000, className, style }: Props) {
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
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
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration]);

  return (
    <span className={className} style={style}>
      {display}
    </span>
  );
}
