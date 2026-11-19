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
/** How far from the mark the pointer must be for the mark to look all the way to it. */
const LOOK_REACH_PX = 600;
/** How much of the way to its target the viewpoint moves each frame: a soft follow. */
const EASE = 0.07;

interface Props {
  className?: string;
  /** Rings inside the rim: the widget's six by default, more for a deeper shaft. */
  rings?: number;
  /** Keep looking at the pointer, wherever it is and whether it moves or not. */
  watchPointer?: boolean;
  /** A label for a mark that says something; without one it is decoration. */
  label?: string;
}

/**
 * The Askr mark, alive: the viewer drifts over the opening as in the widget, and with
 * `watchPointer` the shaft's far end turns toward the pointer and keeps looking at it, until the
 * pointer moves again (it drifts only until a pointer shows up). It moves only while it is on
 * screen, and stays still for a visitor who asked for less motion.
 */
export function LiveMark({ className, rings = MARK_RINGS, watchPointer, label }: Props) {
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
    /** The pointer's last place on the screen, once there has been one. */
    let pointer: { x: number; y: number } | undefined;
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
      const target = pointer === undefined ? driftViewpoint(time) : lookAt(pointer);
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
    // Measured from the mark where it is now, so it keeps looking at a still pointer as the
    // page scrolls under it. The far end of the shaft moves toward the pointer, like an eye.
    const lookAt = (place: { x: number; y: number }): Point => {
      const box = svg.getBoundingClientRect();
      const across = (place.x - (box.left + box.width / 2)) / LOOK_REACH_PX;
      const down = (place.y - (box.top + box.height / 2)) / LOOK_REACH_PX;
      return [
        VIEW_CENTER[0] + Math.max(-1, Math.min(1, across)) * VIEW_RANGE[0],
        VIEW_CENTER[1] + Math.max(-1, Math.min(1, down)) * VIEW_RANGE[1],
      ];
    };
    const onPointer = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      start();
    });
    observer.observe(svg);
    if (watchPointer) {
      window.addEventListener('pointermove', onPointer, { passive: true });
    }
    return () => {
      observer.disconnect();
      window.removeEventListener('pointermove', onPointer);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [watchPointer, rings]);

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
