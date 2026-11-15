import { LIMITS } from '@elisym/askr';

export interface OptionRow {
  name: string;
  /** The values as typed, comma-separated: `S, M, L`. */
  values: string;
}

interface Props {
  rows: readonly OptionRow[];
  onChange: (rows: OptionRow[]) => void;
}

/** The ways a product varies (Size, Color); every combination of values becomes a variant. */
export function OptionsEditor({ rows, onChange }: Props) {
  const update = (index: number, change: Partial<OptionRow>) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...change } : row)));

  return (
    <fieldset className="flex flex-col gap-8">
      <legend className="field-label">Options (optional)</legend>
      <span className="field-hint">
        Sizes, colors and the like. Separate values with commas; each combination becomes a variant
        with its own price and stock.
      </span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-8">
          <input
            className="input"
            aria-label={`Option ${index + 1} name`}
            placeholder="Size"
            value={row.name}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            className="input"
            aria-label={`Option ${index + 1} values`}
            placeholder="S, M, L"
            value={row.values}
            onChange={(event) => update(index, { values: event.target.value })}
          />
          <button
            type="button"
            className="btn"
            aria-label={`Remove option ${index + 1}`}
            onClick={() => onChange(rows.filter((_row, rowIndex) => rowIndex !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      {rows.length >= LIMITS.MAX_OPTIONS ? null : (
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => onChange([...rows, { name: '', values: '' }])}
          >
            Add an option
          </button>
        </div>
      )}
    </fieldset>
  );
}
