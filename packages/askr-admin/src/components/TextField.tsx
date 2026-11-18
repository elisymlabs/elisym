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
  /** Shown but not editable (an ID that cannot change). */
  readOnly?: boolean;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder,
  readOnly,
  info,
}: Props) {
  return (
    <div className="field">
      <FieldLabel htmlFor={id} label={label} info={info} />
      <input
        id={id}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        className="input"
        type="text"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
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
