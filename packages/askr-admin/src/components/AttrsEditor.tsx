import { LIMITS } from '@elisym/askr';

export interface AttrRow {
  name: string;
  value: string;
}

interface Props {
  rows: readonly AttrRow[];
  onChange: (rows: AttrRow[]) => void;
}

/** Product attributes (material, brand, weight): the assistant can filter and compare by them. */
export function AttrsEditor({ rows, onChange }: Props) {
  const update = (index: number, change: Partial<AttrRow>) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...change } : row)));

  return (
    <fieldset className="flex flex-col gap-8">
      <legend className="field-label">Attributes (optional)</legend>
      <span className="field-hint">
        Facts a shopper may ask about, such as Material: wool or Weight: 1.2 kg.
      </span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-8">
          <input
            className="input"
            aria-label={`Attribute ${index + 1} name`}
            placeholder="Material"
            value={row.name}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            className="input"
            aria-label={`Attribute ${index + 1} value`}
            placeholder="Wool"
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="btn"
            aria-label={`Remove attribute ${index + 1}`}
            onClick={() => onChange(rows.filter((_row, rowIndex) => rowIndex !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      {rows.length >= LIMITS.MAX_ATTRS ? null : (
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => onChange([...rows, { name: '', value: '' }])}
          >
            Add an attribute
          </button>
        </div>
      )}
    </fieldset>
  );
}
