import { useCallback, useRef } from 'react';
import { BUTTON } from '../buttons';
import { PRODUCT_NAME, START_LABEL } from '../constants';
import { VIEW_CENTER, markPaths } from '../mark';
import { useScrollProgress } from '../useScrollProgress';
import { AdminLink } from './AdminLink';

/**
 * The mark looking straight down the shaft. The dive zooms on its innermost ring, centered at
 * (50, 63.6) of the 100 x 100 box: the `origin-[50%_63.6%]` below.
 */
const PATHS = markPaths(VIEW_CENTER);
/** How far the dive goes: the innermost ring ends up covering the screen. */
const MAX_ZOOM = 40;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * The page ends by falling into the mark: as the block scrolls, the shaft grows until its
 * innermost ring fills the screen, and the call to start appears on it.
 */
export function Closing() {
  const sectionRef = useRef<HTMLElement>(null);
  const markRef = useRef<SVGSVGElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const outroRef = useRef<HTMLDivElement>(null);

  const onProgress = useCallback((progress: number) => {
    const dive = clamp((progress - 0.15) / 0.6);
    if (markRef.current !== null) {
      markRef.current.style.transform = `scale(${MAX_ZOOM ** (dive * dive)})`;
    }
    if (introRef.current !== null) {
      introRef.current.style.opacity = String(1 - clamp(progress / 0.2));
    }
    if (outroRef.current !== null) {
      const shown = clamp((progress - 0.72) / 0.15);
      outroRef.current.style.opacity = String(shown);
      outroRef.current.style.transform = `translateY(${(1 - shown) * 24}px)`;
      outroRef.current.style.visibility = shown > 0 ? 'visible' : 'hidden';
    }
  }, []);
  useScrollProgress(sectionRef, onProgress);

  return (
    <section ref={sectionRef} id="closing" className="relative h-[280vh]">
      <div className="sticky top-0 flex h-screen items-center justify-center overflow-hidden">
        <svg
          ref={markRef}
          viewBox="0 0 100 100"
          aria-hidden="true"
          focusable="false"
          className="absolute w-[min(52vmin,480px)] origin-[50%_63.6%] [--mark-ink:var(--ink)]"
        >
          {PATHS.map((path, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <path key={index} d={path} className={index % 2 === 0 ? 'mark-ink' : 'mark-paper'} />
          ))}
        </svg>
        <div ref={introRef} className="pointer-events-none absolute top-[16vh] px-16 text-center">
          <p className="font-serif text-[clamp(2.5rem,6vw,6rem)] leading-[0.95] tracking-[-0.03em]">
            Ready when <em className="text-text-3">you are.</em>
          </p>
        </div>
        <div
          ref={outroRef}
          className="text-on-ink relative flex flex-col items-center gap-28 px-16 text-center"
        >
          <h2 className="max-w-1100 font-serif text-[clamp(3rem,8vw,8.5rem)] leading-[0.9] tracking-[-0.03em]">
            Give every visitor <em className="text-on-ink-2">a shop assistant.</em>
          </h2>
          <p className="text-18 sm:text-20 text-on-ink-2 max-w-560 leading-relaxed">
            {`Start free, paste one line, and ${PRODUCT_NAME} starts answering your shoppers from your catalog.`}
          </p>
          <AdminLink label={START_LABEL} className={BUTTON.light} />
        </div>
      </div>
    </section>
  );
}
