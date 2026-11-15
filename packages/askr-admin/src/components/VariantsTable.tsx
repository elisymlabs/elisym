import type { VariantInput } from '../lib/variants';

interface Props {
  variants: readonly VariantInput[];
  onChange: (variants: VariantInput[]) => void;
}

/** One row per combination of option values: its price and whether it is in stock. */
export function VariantsTable({ variants, onChange }: Props) {
  const update = (index: number, change: Partial<VariantInput>) =>
    onChange(
      variants.map((variant, variantIndex) =>
        variantIndex === index ? { ...variant, ...change } : variant,
      ),
    );

  return (
    <table className="text-14 w-full">
      <thead>
        <tr className="text-text-2 text-left">
          <th className="py-4 font-normal">Variant</th>
          <th className="py-4 font-normal">Price</th>
          <th className="py-4 font-normal">In stock</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((variant, index) => {
          const label = variant.values.join(' / ');
          return (
            <tr key={variant.id}>
              <td className="py-4 pr-8">{label}</td>
              <td className="py-4 pr-8">
                <input
                  className="input"
                  aria-label={`Price of ${label}`}
                  value={variant.price}
                  onChange={(event) => update(index, { price: event.target.value.trim() })}
                />
              </td>
              <td className="py-4">
                <input
                  type="checkbox"
                  aria-label={`${label} in stock`}
                  checked={variant.available}
                  onChange={(event) => update(index, { available: event.target.checked })}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
