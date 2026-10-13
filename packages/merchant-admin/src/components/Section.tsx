import type { ReactNode } from 'react';

interface Props {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Section({ title, actions, children }: Props) {
  return (
    <section className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 className="text-18 font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
