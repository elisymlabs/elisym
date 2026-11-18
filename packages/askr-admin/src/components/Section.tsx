import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: ReactNode;
  /** Buttons that act on the whole group, shown at the right of its title. */
  actions?: ReactNode;
  /** The panel has no padding: its content (a table, a list) runs to the edges. */
  flush?: boolean;
  children: ReactNode;
}

/** A settings group: its title and description above, its content in a quiet panel. */
export function Section({ title, description, actions, flush = false, children }: Props) {
  return (
    <section className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end justify-between gap-x-16 gap-y-8">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="text-15 font-semibold">{title}</h2>
          {description === undefined ? null : (
            <p className="text-13 text-text-2 max-w-600">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 gap-8">{actions}</div>}
      </div>
      <div
        className={flush ? 'card flex flex-col overflow-hidden p-0' : 'card flex flex-col gap-16'}
      >
        {children}
      </div>
    </section>
  );
}
