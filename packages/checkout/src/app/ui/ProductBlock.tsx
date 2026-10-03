import type { About } from '../session';

interface Props {
  product: About['product'];
}

/** What is bought, under the product heading of the header: its summary and price (text only). */
export function ProductBlock({ product }: Props) {
  return (
    <div class="product">
      {product.summary === undefined ? null : <p class="summary">{product.summary}</p>}
      <p class="price">
        {product.price.amount} {product.price.currency}
      </p>
    </div>
  );
}
