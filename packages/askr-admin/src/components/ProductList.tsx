import type { CatalogItemInput } from '@elisym/askr';

interface Props {
  items: readonly CatalogItemInput[];
  onEdit: (d: string) => void;
  onRemove: (d: string) => void;
}

export function ProductList({ items, onEdit, onRemove }: Props) {
  if (items.length === 0) {
    return <p className="text-14 text-text-2">No products yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-14 w-full">
        <thead className="text-text-2 text-left">
          <tr>
            <th className="py-6 pr-12 font-medium">ID</th>
            <th className="py-6 pr-12 font-medium">Title</th>
            <th className="py-6 pr-12 font-medium">Price</th>
            <th className="py-6 pr-12 font-medium">Availability</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.d} className="border-line border-t">
              <td className="py-6 pr-12 font-mono">{item.d}</td>
              <td className="py-6 pr-12">{item.title}</td>
              <td className="py-6 pr-12 whitespace-nowrap">
                {item.price.amount} {item.price.currency}
              </td>
              <td className="py-6 pr-12">{(item.visibility ?? 'on-sale').replace('-', ' ')}</td>
              <td className="py-6 text-right whitespace-nowrap">
                <button
                  type="button"
                  className="btn text-13 mr-4"
                  aria-label={`Edit ${item.title}`}
                  onClick={() => onEdit(item.d)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-danger text-13"
                  aria-label={`Remove ${item.title}`}
                  onClick={() => onRemove(item.d)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
