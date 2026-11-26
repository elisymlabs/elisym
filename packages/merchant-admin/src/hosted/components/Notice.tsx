import type { ReactNode } from 'react';

interface Props {
  tone: 'info' | 'warn' | 'error';
  children: ReactNode;
}

const TONES = {
  info: 'bg-blue-bg text-blue',
  warn: 'bg-warn-bg text-warn',
  error: 'bg-error-bg text-error',
} as const;

/** One short message in a tinted box; errors are announced. */
export function Notice({ tone, children }: Props) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-10 text-13 px-12 py-10 leading-relaxed ${TONES[tone]}`}
    >
      {children}
    </p>
  );
}
