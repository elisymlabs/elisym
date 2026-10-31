import type { ReactNode } from 'react';

interface Props {
  /** The label, tied to the control by `htmlFor` when the control is one field. */
  label: string;
  htmlFor?: string;
  help?: ReactNode;
  /** The value or the control. */
  children: ReactNode;
}

/** One setting: its label and help on the left, its value or control on the right. */
export function SettingRow({ label, htmlFor, help, children }: Props) {
  return (
    <div className="grid gap-8 px-20 py-16 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-24">
      <div className="flex min-w-0 flex-col gap-2">
        {htmlFor === undefined ? (
          <span className="text-14 font-medium">{label}</span>
        ) : (
          <label htmlFor={htmlFor} className="text-14 font-medium">
            {label}
          </label>
        )}
        {help === undefined ? null : <span className="text-13 text-text-2">{help}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-8">{children}</div>
    </div>
  );
}
