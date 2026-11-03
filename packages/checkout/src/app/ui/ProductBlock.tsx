import type { About } from '../session';

interface Props {
  product: About['product'];
}

/** What is bought, under the product heading of the header: its summary and price (text only). */
export function ProductBlock({ product }: Props) {
  return (
    <>
      {product.summary === undefined ? null : <p class="summary product-description">{product.summary}</p>}
    <div class="product">
      <span class="amount-label">Total amount</span>
      <p class="price">
        {product.price.amount} <span class="price-currency">{product.price.currency}</span>
      </p>
    </div>
    </>
  );
}
