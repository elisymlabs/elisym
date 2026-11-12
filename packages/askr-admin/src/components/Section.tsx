import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

export function Section({ title, description, children }: Props) {
  return (
    <section className="card flex flex-col gap-16">
      <div className="flex flex-col gap-4">
        <h2 className="text-18 font-semibold">{title}</h2>
        {description === undefined ? null : <p className="text-14 text-text-2">{description}</p>}
      </div>
      {children}
    </section>
  );
}
