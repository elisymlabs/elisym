import type { CatalogItemInput, Visibility } from '@elisym/askr';
import { ProductThumb } from './ProductThumb';

interface Props {
  items: readonly CatalogItemInput[];
  onEdit: (d: string) => void;
  onRemove: (d: string) => void;
}

const BADGES: Readonly<Record<Visibility, string>> = {
  'on-sale': 'badge-green',
  'pre-order': 'badge-warn',
  'sold-out': '',
  hidden: '',
};

export function ProductList({ items, onEdit, onRemove }: Props) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 px-20 py-40 text-center">
        <p className="text-14 font-medium">No products yet.</p>
        <p className="text-13 text-text-2">Add one by hand or import a CSV file.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Product</th>
            <th className="text-right">Price</th>
            <th>Availability</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const visibility = item.visibility ?? 'on-sale';
            return (
              <tr key={item.d}>
                <td className="max-w-360">
                  <div className="flex min-w-0 items-center gap-12">
                    <ProductThumb src={item.images?.[0]} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{item.title}</span>
                      <span className="text-12 text-text-3 truncate font-mono">{item.d}</span>
                    </div>
                  </div>
                </td>
                <td className="text-right whitespace-nowrap tabular-nums">
                  {item.price.amount} <span className="text-text-2">{item.price.currency}</span>
                </td>
                <td>
                  <span className={`badge ${BADGES[visibility]}`}>
                    {visibility.replace('-', ' ')}
                  </span>
                </td>
                <td className="text-right whitespace-nowrap">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Edit ${item.title}`}
                    onClick={() => onEdit(item.d)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger btn-sm"
                    aria-label={`Remove ${item.title}`}
                    onClick={() => onRemove(item.d)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
