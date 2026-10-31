import type { ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
}

/** One panel of the console. */
export function Card({ title, children }: Props) {
  return (
    <section className="rounded-20 border-line bg-surface w-full border p-24 shadow-sm sm:p-32">
      <h2 className="text-20 font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
