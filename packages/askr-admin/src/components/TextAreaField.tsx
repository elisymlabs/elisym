import type { Help } from '../lib/help';
import { FieldLabel } from './FieldLabel';

interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  /** What the info button beside the label says. */
  info?: Help;
  placeholder?: string;
  rows?: number;
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder,
  rows = 3,
  info,
}: Props) {
  return (
    <div className="field">
      <FieldLabel htmlFor={id} label={label} info={info} />
      <textarea
        id={id}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        className="input"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint === undefined ? null : (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
