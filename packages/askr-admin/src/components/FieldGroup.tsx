import type { ReactNode } from 'react';

interface Props {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}

/** A group of settings rows in a form: its title above, the rows in a quiet panel. */
export function FieldGroup({ id, title, description, children }: Props) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-12" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-2">
        <h2 id={`${id}-title`} className="text-15 font-semibold">
          {title}
        </h2>
        {description === undefined ? null : <p className="text-13 text-text-2">{description}</p>}
      </div>
      <div className="card fields-rows">{children}</div>
    </fieldset>
  );
}
