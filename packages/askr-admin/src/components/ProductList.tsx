import type { CatalogItemInput, Visibility } from '@elisym/askr';
import { ProductRowActions, type RowStatus } from './ProductRowActions';
import { ProductThumb } from './ProductThumb';

interface Props {
  items: readonly CatalogItemInput[];
  onEdit: (d: string) => void;
  /** A Remove the merchant confirmed. */
  onRemove: (d: string) => void;
  /** Writes about rows, by product ID; rows not in it are idle. */
  rows?: ReadonlyMap<string, RowStatus>;
  /** Product IDs whose Edit and Remove are off (a write about them is queued). */
  lockedIds?: ReadonlySet<string>;
  /** Every row's Edit and Remove are off. */
  locked?: boolean;
  /** Every row's Edit is off (the open editor's save is on its way). */
  editLocked?: boolean;
  /** No actions at all (the store cannot publish yet). */
  readOnly?: boolean;
}

const BADGES: Readonly<Record<Visibility, string>> = {
  'on-sale': 'badge-green',
  'pre-order': 'badge-warn',
  'sold-out': '',
  hidden: '',
};

export function ProductList({
  items,
  onEdit,
  onRemove,
  rows,
  lockedIds,
  locked = false,
  editLocked = false,
  readOnly = false,
}: Props) {
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
                  {readOnly ? null : (
                    <ProductRowActions
                      item={item}
                      status={rows?.get(item.d)}
                      locked={locked || (lockedIds?.has(item.d) ?? false)}
                      editLocked={editLocked}
                      onEdit={onEdit}
                      onRemove={onRemove}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
