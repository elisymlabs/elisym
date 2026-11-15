import { ANY_OPTION_VALUE } from '@elisym/askr';
import { useState } from 'react';
import { type OptionInput, type VariantInput, variantLabel } from '../lib/variants';

interface Props {
  /** The options as typed; a variant picks one value of each, or Any. */
  options: readonly OptionInput[];
  variants: readonly VariantInput[];
  onChange: (variants: VariantInput[]) => void;
  onAdd: () => void;
  onAddMissing: () => void;
}

/** The choices for one option of one variant: its values, Any, and a value it no longer has. */
function choicesOf(option: OptionInput, current: string) {
  const choices = [
    ...option.values.map((value) => ({ value, label: value })),
    { value: ANY_OPTION_VALUE, label: 'Any' },
  ];
  if (current === '') {
    return [{ value: '', label: 'Pick...' }, ...choices];
  }
  if (current !== ANY_OPTION_VALUE && !option.values.includes(current)) {
    return [{ value: current, label: `${current} (not a value any more)` }, ...choices];
  }
  return choices;
}

/**
 * The product's variants, each a choice of option values with its own price
 * and stock. Nothing here is made or dropped by editing the options: variants
 * come and go only by these buttons.
 */
export function VariantsTable({ options, variants, onChange, onAdd, onAddMissing }: Props) {
  const [samePrice, setSamePrice] = useState('');
  /** An option's name, or its number when it has none or shares its name with another. */
  const selectName = (optionIndex: number) => {
    const optionName = options[optionIndex]?.name ?? '';
    const shared = options.filter((option) => option.name === optionName).length > 1;
    return optionName === '' || shared ? `Option ${optionIndex + 1}` : optionName;
  };
  const update = (index: number, change: Partial<VariantInput>) =>
    onChange(
      variants.map((variant, variantIndex) =>
        variantIndex === index ? { ...variant, ...change } : variant,
      ),
    );

  return (
    <fieldset className="flex flex-col gap-8">
      <legend className="field-label">Variants</legend>
      <span className="field-hint">
        Each variant is one choice a shopper can make, with its own price and stock. Any matches
        every value of that option.
      </span>
      {variants.length === 0 ? null : (
        <>
          <div className="flex items-end gap-8">
            <label className="field" htmlFor="variants-same-price">
              <span className="field-label">One price for every variant</span>
              <input
                id="variants-same-price"
                className="input"
                placeholder="19.90"
                value={samePrice}
                onChange={(event) => setSamePrice(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={samePrice.trim() === ''}
              onClick={() =>
                onChange(variants.map((variant) => ({ ...variant, price: samePrice.trim() })))
              }
            >
              Set for all
            </button>
          </div>
          <table className="text-14 w-full">
            <thead>
              <tr className="text-text-2 text-left">
                {options.map((option, optionIndex) => (
                  <th key={optionIndex} className="py-4 font-normal">
                    {option.name === '' ? `Option ${optionIndex + 1}` : option.name}
                  </th>
                ))}
                <th className="py-4 font-normal">Price</th>
                <th className="py-4 font-normal">In stock</th>
                <th className="py-4 font-normal">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant, index) => {
                const label = variantLabel(variant.values);
                return (
                  <tr key={variant.id}>
                    {options.map((option, optionIndex) => {
                      const current = variant.values[optionIndex] ?? '';
                      return (
                        <td key={optionIndex} className="py-4 pr-8">
                          <select
                            className="input"
                            aria-label={`${selectName(optionIndex)} of variant ${index + 1}`}
                            value={current}
                            onChange={(event) =>
                              update(index, {
                                values: options.map((_other, otherIndex) =>
                                  otherIndex === optionIndex
                                    ? event.target.value
                                    : (variant.values[otherIndex] ?? ''),
                                ),
                              })
                            }
                          >
                            {choicesOf(option, current).map((choice) => (
                              <option key={choice.value} value={choice.value}>
                                {choice.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    })}
                    <td className="py-4 pr-8">
                      <input
                        className="input"
                        aria-label={`Price of variant ${index + 1}`}
                        title={label}
                        value={variant.price}
                        onChange={(event) => update(index, { price: event.target.value.trim() })}
                      />
                    </td>
                    <td className="py-4 pr-8">
                      <input
                        type="checkbox"
                        aria-label={`Variant ${index + 1} in stock`}
                        checked={variant.available}
                        onChange={(event) => update(index, { available: event.target.checked })}
                      />
                    </td>
                    <td className="py-4">
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Remove variant ${index + 1}`}
                        onClick={() =>
                          onChange(variants.filter((_other, otherIndex) => otherIndex !== index))
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <div className="flex gap-8">
        <button type="button" className="btn" onClick={onAdd}>
          Add a variant
        </button>
        <button type="button" className="btn" onClick={onAddMissing}>
          Add every missing combination
        </button>
      </div>
    </fieldset>
  );
}
