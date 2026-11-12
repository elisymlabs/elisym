interface Props {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  hint?: string;
}

export function SelectField({ id, label, value, options, onChange, hint }: Props) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
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
    </label>
  );
}
