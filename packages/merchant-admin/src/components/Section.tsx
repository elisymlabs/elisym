import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** `h1` for the section that heads a page: focus lands on it when the page opens. */
  heading?: 'h1' | 'h2';
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function Section({ title, heading = 'h2', description, actions, children }: Props) {
  const Heading = heading;
  return (
    <section className="flex flex-col gap-16">
      <div className="flex flex-wrap items-end justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-4">
          <Heading
            {...(heading === 'h1' ? { tabIndex: -1 } : {})}
            className={`${heading === 'h1' ? 'text-24' : 'text-18'} font-semibold tracking-tight outline-none`}
          >
            {title}
          </Heading>
          {description !== undefined && <p className="text-14 text-text-2">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
