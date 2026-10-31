import type { ReactNode } from 'react';

interface Props {
  /** The id of the control it labels. */
  id: string;
  label: string;
  /** What the field is for, under the label. */
  hint?: ReactNode;
  /** Why the value is refused, read out with it. */
  error?: string;
  children: ReactNode;
}

/**
 * A label, the control, an optional hint and an error. The control names them
 * itself: `aria-describedby={describedBy(id, hint, error)}` (`lib/field.ts`).
 */
export function Field({ id, label, hint, error, children }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <label htmlFor={id} className="text-14 font-medium">
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-13 text-text-2">
          {hint}
        </p>
      )}
      {children}
      {error === undefined || error === '' ? null : (
        <p id={`${id}-error`} role="alert" className="text-13 text-error">
          {error}
        </p>
      )}
    </div>
  );
}
