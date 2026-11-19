import type { Help } from '../lib/help';
import { FieldLabel } from './FieldLabel';

interface Props {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  hint?: string;
  /** What the info button beside the label says. */
  info?: Help;
}

export function SelectField({ id, label, value, options, onChange, hint, info }: Props) {
  return (
    <div className="field">
      <FieldLabel htmlFor={id} label={label} info={info} />
      <select
        id={id}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint === undefined ? null : (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
