import type { About, Paying } from '../session';
import { ChainGlyph } from './ChainGlyph';
import { amountText, networkLabel } from './text';

/** The exact amount and network, without repeating the price or payment verb. */
export function PaymentSummary({
  product,
  paying,
}: {
  product: About['product'];
  paying: Paying | undefined;
}) {
  return (
    <div class="payment-summary" aria-label="Payment summary">
      <span class="summary-amount">
        {paying === undefined
          ? `${product.price.amount} ${product.price.currency}`
          : amountText(paying)}
      </span>
      {paying === undefined ? null : (
        <span class="summary-network">
          <ChainGlyph chain={paying.chain} />
          <span>{networkLabel(paying.chain, paying.network)}</span>
        </span>
      )}
    </div>
  );
}
