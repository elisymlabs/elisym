import type { Snapshot } from '../lib/core';
import { Section } from './Section';

interface Props {
  products: Snapshot['allProducts'];
}

/** Every listing of the store read so far, read-only: the node publishes them. */
export function ProductsSection({ products }: Props) {
  const lines = products?.lines ?? [];
  return (
    <Section title="Products">
      {products?.incomplete === true && (
        <p id="products-incomplete" className="text-14 text-warn">
          The store may have more products than shown.
        </p>
      )}
      <ul id="products" className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {lines.map((product) => (
          <li
            key={product.address}
            className="rounded-12 border-line bg-surface flex flex-col gap-2 border p-14"
          >
            <span className="truncate font-medium" title={product.title}>
              {product.title}
            </span>
            <span className="text-12 text-text-2 truncate font-mono" title={product.d}>
              {product.d}
            </span>
            <span className="text-14 mt-4 flex items-center justify-between">
              <span>{product.price}</span>
              <span className={product.onSale ? 'text-green' : 'text-text-2'}>
                {product.onSale ? 'on sale' : 'sold out'}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {lines.length === 0 && <p className="text-14 text-text-2">No product found.</p>}
      <p className="text-13 text-text-2">
        Products are read-only here: your node publishes them (<code>setup</code>).
      </p>
    </Section>
  );
}
