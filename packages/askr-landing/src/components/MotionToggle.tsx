import { useState } from 'react';
import { prefersReducedMotion } from '../useInView';

interface Props {
  paused: boolean;
  onToggle: () => void;
  /** What moves, for the button's name: "the store list", "the questions". */
  what: string;
}

/**
 * A small Pause / Play button for content that moves on its own (WCAG 2.2.2). Its name says
 * what pressing it does. A visitor who asked for less motion sees nothing move, so no button.
 */
export function MotionToggle({ paused, onToggle, what }: Props) {
  const [still] = useState(prefersReducedMotion);
  if (still) {
    return null;
  }
  const action = paused ? 'Play' : 'Pause';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${action} ${what}`}
      className="text-13 text-text-2 hover:text-text rounded-full px-10 py-6 font-medium underline-offset-4 hover:underline"
    >
      {action}
    </button>
  );
}
