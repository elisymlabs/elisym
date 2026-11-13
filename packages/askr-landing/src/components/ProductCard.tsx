import type { Product } from '../media';
import { Icon } from './Icon';

interface Props {
  product: Product;
}

/** A product card as the widget draws it: the price comes from the store's catalog. */
export function ProductCard({ product }: Props) {
  return (
    <div className="rounded-16 border-line bg-surface text-text flex items-center gap-12 border p-8 pr-12">
      <img
        src={product.image}
        alt=""
        width={56}
        height={56}
        className="rounded-12 bg-surface-2 size-56 shrink-0 object-cover"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-14 truncate font-medium">{product.title}</span>
        <span className="text-12 text-text-3 truncate">{product.note}</span>
      </span>
      <span className="flex flex-col items-end gap-6">
        <span className="text-14 font-semibold tabular-nums">{product.price}</span>
        <span className="bg-ink text-11 text-on-ink flex items-center gap-4 rounded-full px-8 py-4 font-medium">
          <Icon name="cart" className="size-12" />
          Add to cart
        </span>
      </span>
    </div>
  );
}
