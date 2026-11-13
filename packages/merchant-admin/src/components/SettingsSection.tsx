import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: ReactNode;
  /** The section's one action (Save), under its rows. */
  footer?: ReactNode;
  children: ReactNode;
}

/** A group of settings as rows, one save for the group: the way a settings page reads. */
export function SettingsSection({ title, description, footer, children }: Props) {
  return (
    <section className="rounded-16 border-line bg-surface flex flex-col border">
      <div className="border-line flex flex-col gap-4 border-b px-20 py-16">
        <h2 className="text-16 font-semibold">{title}</h2>
        {description === undefined ? null : <p className="text-13 text-text-2">{description}</p>}
      </div>
      <div className="divide-line flex flex-col divide-y">{children}</div>
      {footer === undefined ? null : (
        <div className="border-line flex flex-col gap-8 border-t px-20 py-16">{footer}</div>
      )}
    </section>
  );
}
