import type { About } from '../session';

interface Props {
  product: About['product'];
}

/**
 * What is bought, as the store lists it (text only). Its title takes focus only
 * as the last fallback: it is never the section heading an action moves to.
 */
export function ProductBlock({ product }: Props) {
  return (
    <div class="product">
      <h2 class="product-title" tabindex={-1}>
        {product.title}
      </h2>
      {product.summary === undefined ? null : <p class="summary">{product.summary}</p>}
      <p class="price">
        {product.price.amount} {product.price.currency}
      </p>
    </div>
  );
}
