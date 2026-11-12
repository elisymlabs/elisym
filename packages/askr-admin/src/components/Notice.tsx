import type { ReactNode } from 'react';

interface Props {
  tone: 'error' | 'info' | 'success' | 'warn';
  children: ReactNode;
}

const TONES: Readonly<Record<Props['tone'], string>> = {
  error: 'bg-error-bg text-error',
  info: 'bg-surface-2 text-text-2',
  success: 'bg-green-bg text-green',
  warn: 'bg-warn-bg text-warn',
};

export function Notice({ tone, children }: Props) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-10 text-14 px-12 py-10 ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}
