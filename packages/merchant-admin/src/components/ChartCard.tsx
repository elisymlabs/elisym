import type { ReactNode } from 'react';

interface Props {
  title: string;
  caption?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A chart in the dashboard's card style: title, a line under it, the chart. */
export function ChartCard({ title, caption, actions, children, className = '' }: Props) {
  return (
    <section
      className={`rounded-16 border-line bg-surface flex min-w-0 flex-col gap-16 border p-16 sm:p-20 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-15 font-semibold tracking-tight">{title}</h3>
          {caption !== undefined && <p className="text-13 text-text-2">{caption}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
