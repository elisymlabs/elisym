import { useEffect, useRef, useState } from 'react';

const DEFAULT_DURATION_MS = 700;

function easeOutQuart(t: number): number {
  return 1 - (1 - t) ** 4;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Snap to the first defined `target` (so a cached value lands instantly on
 * mount / page refresh without a 0→value count-up), then tween subsequent
 * changes. Pass `undefined` while data is loading.
 */
export function useTweenedNumber(
  target: number | undefined,
  durationMs = DEFAULT_DURATION_MS,
): number {
  const [display, setDisplay] = useState(target ?? 0);
  const displayRef = useRef(target ?? 0);
  const initializedRef = useRef(target !== undefined);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === undefined) {
      return;
    }
    if (!initializedRef.current) {
      initializedRef.current = true;
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    if (displayRef.current === target) {
      return;
    }
    if (prefersReducedMotion() || durationMs <= 0 || !Number.isFinite(target)) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const from = displayRef.current;
    let startTime: number | null = null;

    const tick = (now: number) => {
      if (startTime === null) {
        startTime = now;
      }
      const progress = Math.min(1, (now - startTime) / durationMs);
      const next = from + (target - from) * easeOutQuart(progress);
      displayRef.current = next;
      setDisplay(next);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, durationMs]);

  return display;
}
