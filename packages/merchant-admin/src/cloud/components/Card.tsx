import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Its heading's level: `h3` where it sits under a section of its own. */
  level?: 'h2' | 'h3';
  children: ReactNode;
}

/** One panel of the console. */
export function Card({ title, level = 'h2', children }: Props) {
  const Heading = level;
  return (
    <section className="rounded-20 border-line bg-surface w-full border p-24 shadow-sm sm:p-32">
      <Heading className="text-20 font-semibold tracking-tight">{title}</Heading>
      {children}
    </section>
  );
}
