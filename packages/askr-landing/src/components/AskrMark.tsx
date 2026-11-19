import { MARK_STILL_PATHS, MARK_TIGHT_BOX } from '../brand';

interface Props {
  className?: string;
  /** Drawn to the rim's edges, with no margin around it. */
  tight?: boolean;
}

/** The Askr mark, drawn still, in the text color on the page's paper. */
export function AskrMark({ className, tight = false }: Props) {
  return (
    <svg
      viewBox={tight ? MARK_TIGHT_BOX : '0 0 100 100'}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {MARK_STILL_PATHS.map((path, index) => (
        <path key={path} d={path} className={index % 2 === 0 ? 'mark-ink' : 'mark-paper'} />
      ))}
    </svg>
  );
}
