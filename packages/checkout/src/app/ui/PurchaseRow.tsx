import type { Purchase } from '../history';
import { StatusBadge } from './StatusBadge';
import { amountText, purchaseDay, receiptField } from './text';

interface Props {
  purchase: Purchase;
  onOpen(orderId: string): void;
}

/** One purchase in the list: the product and its amount, then the day and its status. */
export function PurchaseRow({ purchase, onOpen }: Props) {
  const product = receiptField(purchase.receipt.product);
  const paying = purchase.receipt.paying;
  return (
    <li>
      <button
        type="button"
        class="purchase-row"
        data-order={purchase.orderId}
        onClick={() => onOpen(purchase.orderId)}
      >
        <span class="purchase-product" title={product}>
          <span class="purchase-product-label">{product}</span>
        <span class="purchase-view-arrow" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        </span>
        <span class="purchase-amount">{paying === undefined ? null : amountText(paying)}</span>
        <span class="purchase-day">{purchaseDay(purchase.createdAt)}</span>
        <StatusBadge status={purchase.status} />

      </button>
    </li>
  );
}
