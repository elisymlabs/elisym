interface Props {
  tone: 'ok' | 'wait' | 'warn' | 'off';
  children: string;
}

const TONES = {
  ok: 'bg-ok-bg text-ok',
  wait: 'bg-surface-2 text-text-2',
  warn: 'bg-warn-bg text-warn',
  off: 'bg-surface-2 text-text-3',
} as const;

/** A short state, as text and tone: never color alone. */
export function ToneBadge({ tone, children }: Props) {
  return (
    <span
      data-tone={tone}
      className={`rounded-6 text-12 inline-flex items-center px-8 py-2 font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
