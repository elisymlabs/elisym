import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

export function Code({ children }: Props) {
  return <code className="rounded-4 bg-surface-2 text-13 px-4 py-1 font-mono">{children}</code>;
}
