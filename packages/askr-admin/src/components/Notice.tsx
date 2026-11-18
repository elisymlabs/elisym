import type { ReactNode } from 'react';

interface Props {
  tone: 'error' | 'info' | 'success' | 'warn';
  children: ReactNode;
}

const TONES: Readonly<Record<Props['tone'], string>> = {
  error: 'bg-error-bg text-error border-error/20',
  info: 'bg-surface-2 text-text-2 border-line',
  success: 'bg-green-bg text-green border-green/20',
  warn: 'bg-warn-bg text-warn border-warn/20',
};

export function Notice({ tone, children }: Props) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-10 text-13 border px-14 py-10 leading-relaxed ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}
