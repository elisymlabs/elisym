import type { ComponentChildren } from 'preact';
import type { About } from '../session';

interface Props {
  product: About['product'];
  network?: ComponentChildren;
}

/** What is bought, under the product heading of the header: its summary and price (text only). */
export function ProductBlock({ product, network }: Props) {
  return (
    <>
      {product.summary === undefined ? null : (
        <p class="summary product-description">{product.summary}</p>
      )}
      <div class="product">
        <div class="product-topline">
          <span class="amount-label">Total amount</span>
          {network}
        </div>
        <p class="price">
          {product.price.amount} <span class="price-currency">{product.price.currency}</span>
        </p>
      </div>
    </>
  );
}
