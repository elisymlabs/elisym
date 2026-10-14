interface Props {
  className?: string;
}

/** The Pay Core mark, inline (no image request): the same drawing as the favicon. */
export function LogoMark({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" fill="#c6f432" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="#0b0b0f" strokeWidth="3" />
      <circle cx="16" cy="16" r="3" fill="#0b0b0f" />
    </svg>
  );
}
