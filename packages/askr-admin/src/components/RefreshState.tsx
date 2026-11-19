export type RefreshStatus = 'idle' | 'busy' | 'done' | 'failed';

interface Props {
  status: RefreshStatus;
}

/** Beside Refresh: a spinner while it reads, then a check (or a cross) for a moment. */
export function RefreshState({ status }: Props) {
  if (status === 'idle') {
    return null;
  }
  if (status === 'busy') {
    return (
      <svg
        viewBox="0 0 16 16"
        className="text-text-3 size-14 animate-spin"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M14 8a6 6 0 1 1-6-6" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-14 ${status === 'done' ? 'text-green' : 'text-error'}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={status === 'done' ? 'm3.5 8.5 3 3 6-7' : 'm4.5 4.5 7 7m0-7-7 7'} />
    </svg>
  );
}
