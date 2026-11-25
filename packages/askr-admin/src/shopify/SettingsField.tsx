interface Props {
  label: string;
  value: string;
  max: number;
  multiline?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}

/** One labelled field of the embedded settings form. */
export function SettingsField({ label, value, max, multiline = false, disabled, onChange }: Props) {
  return (
    <label className="flex flex-col gap-4">
      <span className="text-13 font-medium">{label}</span>
      {multiline ? (
        <textarea
          className="input"
          rows={4}
          maxLength={max}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="input"
          maxLength={max}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
