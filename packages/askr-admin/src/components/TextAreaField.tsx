interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  rows?: number;
}

export function TextAreaField({ id, label, value, onChange, hint, placeholder, rows = 3 }: Props) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
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
    </label>
  );
}
