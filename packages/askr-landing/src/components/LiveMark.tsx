import { useEffect, useRef } from 'react';
import {
  DRIFT_START,
  MARK_RINGS,
  type Point,
  VIEW_CENTER,
  VIEW_RANGE,
  driftViewpoint,
  markPaths,
} from '../mark';
import { prefersReducedMotion } from '../useInView';

/** How fast the drift runs, in radians of the slower axis per second (the widget's pace). */
const DRIFT_SPEED = 0.18;
/** After this long with no pointer, the mark goes back to drifting on its own. */
const POINTER_IDLE_MS = 2500;
/** How much of the way to its target the viewpoint moves each frame: a soft follow. */
const EASE = 0.07;

interface Props {
  className?: string;
  /** Rings inside the rim: the widget's six by default, more for a deeper shaft. */
  rings?: number;
  /** Look down the shaft from where the pointer is on the screen. */
  followPointer?: boolean;
  /** A label for a mark that says something; without one it is decoration. */
  label?: string;
}

/**
 * The Askr mark, alive: the viewer drifts over the opening as in the widget, and with
 * `followPointer` looks down the shaft from wherever the pointer is. It moves only while it
 * is on screen, and stays still for a visitor who asked for less motion.
 */
export function LiveMark({ className, rings = MARK_RINGS, followPointer, label }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const initial = markPaths(driftViewpoint(DRIFT_START), rings);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      return undefined;
    }
    const paths = [...svg.querySelectorAll('path')];
    let time = DRIFT_START;
    let focus: Point = driftViewpoint(time);
    let pointer: Point | undefined;
    let pointerAt = 0;
    let visible = false;
    let frame: number | undefined;
    let last = 0;

    const tick = (now: number) => {
      frame = undefined;
      if (!visible) {
        return;
      }
      const elapsed = Math.min(now - last, 64);
      last = now;
      time += (elapsed / 1000) * DRIFT_SPEED;
      const following = pointer !== undefined && now - pointerAt < POINTER_IDLE_MS;
      const target = following && pointer !== undefined ? pointer : driftViewpoint(time);
      focus = [focus[0] + (target[0] - focus[0]) * EASE, focus[1] + (target[1] - focus[1]) * EASE];
      const shapes = markPaths(focus, rings);
      paths.forEach((path, index) => path.setAttribute('d', shapes[index] ?? ''));
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (frame === undefined && visible) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    const onPointer = (event: PointerEvent) => {
      const across = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth) * 2 - 1));
      const down = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight) * 2 - 1));
      // Looking from the left shows the right wall: the point under the viewer goes the other way.
      pointer = [VIEW_CENTER[0] - across * VIEW_RANGE[0], VIEW_CENTER[1] - down * VIEW_RANGE[1]];
      pointerAt = performance.now();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      start();
    });
    observer.observe(svg);
    if (followPointer) {
      window.addEventListener('pointermove', onPointer, { passive: true });
    }
    return () => {
      observer.disconnect();
      window.removeEventListener('pointermove', onPointer);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [followPointer, rings]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      className={className}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
    >
      {initial.map((path, index) => (
        // The rings never reorder: the index is the ring.
        // eslint-disable-next-line react/no-array-index-key
        <path key={index} d={path} className={index % 2 === 0 ? 'mark-ink' : 'mark-paper'} />
      ))}
    </svg>
  );
}
