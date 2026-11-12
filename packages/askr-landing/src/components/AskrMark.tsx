interface Props {
  className?: string;
}

/** Askr's mark: a speech bubble on the accent tile, as the favicon draws it. */
export function AskrMark({ className = 'size-28' }: Props) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path
        d="M9 10.5A2.5 2.5 0 0 1 11.5 8h9A2.5 2.5 0 0 1 23 10.5v7a2.5 2.5 0 0 1-2.5 2.5H15l-4.5 3.5V20A1.5 1.5 0 0 1 9 18.5v-8Z"
        fill="none"
        strokeWidth="2.4"
        strokeLinejoin="round"
        className="stroke-accent-text"
      />
      <circle cx="16" cy="14" r="1.6" className="fill-accent-text" />
    </svg>
  );
}
