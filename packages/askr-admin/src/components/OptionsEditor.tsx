import { LIMITS } from '@elisym/askr';
import { useRef } from 'react';
import { HELP } from '../lib/help';
import { optionValuesOf } from '../lib/variants';
import { InfoTip } from './InfoTip';

export interface OptionRow {
  /** The row's identity while it is edited; empty for a row just added. */
  key: string;
  name: string;
  /** The values as shown and typed, comma-separated: `S, M, L`. */
  text: string;
  /**
   * The values. Read from `text` only once it is edited, so a value with a
   * comma in it (`Red, White`, `10,5`) stays whole while the row is untouched.
   */
  values: string[];
}

interface Props {
  rows: readonly OptionRow[];
  onChange: (rows: OptionRow[]) => void;
  /** A values field was left: its values when it was entered and now. */
  onValuesDone: (key: string, before: readonly string[], after: readonly string[]) => void;
}

/** The ways a product varies (Size, Color); every combination of values becomes a variant. */
export function OptionsEditor({ rows, onChange, onValuesDone }: Props) {
  // The values of the field being typed in, as they were when it was entered: a rename is
  // judged once it is left, never from a half-typed value.
  const entered = useRef<{ index: number; values: string[] } | undefined>(undefined);

  const update = (index: number, change: Partial<OptionRow>) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...change } : row)));

  return (
    <fieldset className="flex flex-col gap-8">
      <legend className="field-label flex items-center gap-6">
        Options (optional)
        <InfoTip help={HELP.productOptions} about="Options" />
      </legend>
      <span className="field-hint">
        Sizes, colors and the like. Separate values with commas. Editing options never adds or
        removes a variant: a value you replace by another is renamed in the variants too, and the
        variants below say what still needs a choice.
      </span>
      {rows.map((row, index) => (
        <div key={row.key === '' ? `new-${index}` : row.key} className="flex items-center gap-8">
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
            value={row.text}
            onFocus={() => {
              entered.current = { index, values: row.values };
            }}
            onBlur={() => {
              const before = entered.current;
              entered.current = undefined;
              if (before !== undefined && before.index === index) {
                onValuesDone(row.key, before.values, row.values);
              }
            }}
            onChange={(event) =>
              update(index, {
                text: event.target.value,
                values: optionValuesOf(event.target.value),
              })
            }
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
            onClick={() => onChange([...rows, { key: '', name: '', text: '', values: [] }])}
          >
            Add an option
          </button>
        </div>
      )}
    </fieldset>
  );
}
