import { WORDMARK_BOX, WORDMARK_PATH } from '../brand';

interface Props {
  /** Size it with classes: a height (and `w-auto`) or a width. */
  className?: string;
}

/** "Askr" alone, in the current color. */
export function Wordmark({ className = 'w-auto' }: Props) {
  return (
    <svg
      viewBox={WORDMARK_BOX}
      className={`block ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <path d={WORDMARK_PATH} fill="currentColor" />
    </svg>
  );
}
