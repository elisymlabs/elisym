interface Props {
  paused: boolean;
  onToggle: () => void;
  /** What moves, for the button's name: "the store list", "the questions". */
  what: string;
}

/** A small Pause / Play button for content that moves on its own (WCAG 2.2.2). */
export function MotionToggle({ paused, onToggle, what }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={paused}
      aria-label={`${paused ? 'Play' : 'Pause'} ${what}`}
      className="text-13 text-text-2 hover:text-text rounded-full px-10 py-6 font-medium underline-offset-4 hover:underline"
    >
      {paused ? 'Play' : 'Pause'}
    </button>
  );
}
