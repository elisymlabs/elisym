import { type RefObject, useEffect } from 'react';
import { prefersReducedMotion } from './useInView';

/**
 * Calls `onProgress` with how far a tall block has been scrolled through, from 0 (its top at
 * the top of the screen) to 1 (its bottom at the bottom), once a frame at most. A visitor who
 * asked for less motion gets 1 once and nothing after.
 */
export function useScrollProgress(
  ref: RefObject<HTMLElement | null>,
  onProgress: (progress: number) => void,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    if (prefersReducedMotion()) {
      onProgress(1);
      return undefined;
    }
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const box = element.getBoundingClientRect();
      const travel = box.height - window.innerHeight;
      onProgress(travel <= 0 ? 1 : Math.max(0, Math.min(1, -box.top / travel)));
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
  }, [ref, onProgress]);
}
