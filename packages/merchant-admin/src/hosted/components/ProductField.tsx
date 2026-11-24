import type { ReactNode } from 'react';

interface Props {
  label: string;
  problem: string | undefined;
  children: ReactNode;
}

/** One editor field with its label, and its fixed problem sentence under it. */
export function ProductField({ label, problem, children }: Props) {
  return (
    <label className="text-14 flex flex-col gap-4">
      {label}
      {children}
      {problem === undefined ? null : <span className="text-13 text-error">{problem}</span>}
    </label>
  );
}
