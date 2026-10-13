interface Props {
  status: string;
  busy: boolean;
}

/** The session's last word: reading, read, or why it could not. */
export function StatusLine({ status, busy }: Props) {
  const failed = status.startsWith('Could not read');
  let dot = 'bg-green';
  if (busy) {
    dot = 'bg-accent-ink animate-pulse';
  } else if (failed) {
    dot = 'bg-error';
  }
  return (
    <div className="order-last flex w-full min-w-0 items-center gap-8 md:order-none md:w-auto md:max-w-360">
      <span aria-hidden="true" className={`size-8 shrink-0 rounded-full ${dot}`} />
      <p
        role="status"
        className={`text-13 truncate ${failed ? 'text-error' : 'text-text-2'}`}
        title={status}
      >
        {status}
      </p>
    </div>
  );
}
