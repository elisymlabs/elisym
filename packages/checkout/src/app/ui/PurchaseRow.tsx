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
          {product}
        </span>
        <span class="purchase-amount">{paying === undefined ? null : amountText(paying)}</span>
        <span class="purchase-day">{purchaseDay(purchase.createdAt)}</span>
        <StatusBadge status={purchase.status} />
      </button>
    </li>
  );
}
