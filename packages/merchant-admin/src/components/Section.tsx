import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function Section({ title, description, actions, children }: Props) {
  return (
    <section className="flex flex-col gap-16">
      <div className="flex flex-wrap items-end justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-4">
          <h2 className="text-18 font-semibold tracking-tight">{title}</h2>
          {description !== undefined && <p className="text-14 text-text-2">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
