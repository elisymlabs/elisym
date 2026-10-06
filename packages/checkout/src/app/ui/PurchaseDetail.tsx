import { useEffect, useState } from 'preact/hooks';
import type { Purchase } from '../history';
import { CopyReceiptButton } from './CopyReceiptButton';
import { OrderIdValue } from './OrderIdValue';
import { StatusBadge } from './StatusBadge';
import {
  PURCHASES_TEXT,
  PURCHASE_STATUS_NOTES,
  amountText,
  networkLabel,
  receiptField,
  receiptMoment,
  receiptText,
} from './text';
import { TxLink } from './TxLink';

interface Props {
  /** The purchase as the list read it: shown at once. */
  purchase: Purchase;
  /** The purchase as it stands now, its sent transaction checked on chain. */
  fresh(orderId: string): Promise<Purchase | undefined>;
}

function kindOf(purchase: Purchase): 'delivered' | 'refunded' | 'open' {
  if (purchase.status === 'delivered' || purchase.status === 'refunded') {
    return purchase.status;
  }
  return 'open';
}

/**
 * One purchase, inside the fixed "Your purchases" box, as one flat card: the
 * amount and its status, when and where, then the product, the order and the
 * transaction. "Copy receipt" copies the full receipt text. Drawn from the
 * list's read, then from the record read again (an order completed since shows
 * as completed); a sent transaction appears only after its chain check, and a
 * check that ends after the detail closed draws nothing.
 */
export function PurchaseDetail({ purchase, fresh }: Props) {
  const [shown, setShown] = useState<Purchase>(purchase);
  useEffect(() => {
    let open = true;
    void fresh(purchase.orderId)
      .then((now) => {
        if (open && now !== undefined) {
          setShown(now);
        }
      })
      .catch(() => undefined);
    return () => {
      open = false;
    };
  }, [purchase.orderId, fresh]);
  const kind = kindOf(shown);
  const { receipt } = shown;
  const moment = receiptMoment(receipt, kind) ?? {
    label: 'Ordered on',
    at: receipt.orderedAt ?? shown.createdAt,
  };
  const when = new Date(moment.at * 1000);
  const note = PURCHASE_STATUS_NOTES[shown.status];
  let transaction: { label: string; tx: string; explorer?: string } | undefined;
  if (receipt.paid !== undefined) {
    transaction = { label: PURCHASES_TEXT.transaction, ...receipt.paid };
  } else if (receipt.sent !== undefined) {
    transaction = { label: PURCHASES_TEXT.transactionSent, ...receipt.sent };
  }
  return (
    <section class="purchase-card" aria-label={PURCHASES_TEXT.details}>
      <div class="purchase-hero">
        {receipt.paying === undefined ? null : (
          <p class="purchase-total">{amountText(receipt.paying)}</p>
        )}
        <StatusBadge status={shown.status} />
      </div>
      <p class="purchase-meta">
        <time dateTime={when.toISOString()} title={moment.label}>
          {when.toLocaleString()}
        </time>
        {receipt.paying === undefined
          ? null
          : ` · ${networkLabel(receipt.paying.chain, receipt.paying.network)}`}
      </p>
      {note === undefined ? null : <p class="note">{note}</p>}
      {kind === 'open' && !shown.thisProduct ? (
        <p class="note">{PURCHASES_TEXT.otherProduct}</p>
      ) : null}
      <dl class="purchase-facts">
        <div>
          <dt>{PURCHASES_TEXT.product}</dt>
          <dd>{receiptField(receipt.product)}</dd>
        </div>
        <div>
          <dt>{PURCHASES_TEXT.order}</dt>
          <dd>
            <OrderIdValue orderId={receipt.orderId} />
          </dd>
        </div>
        {transaction === undefined ? null : (
          <div>
            <dt>{transaction.label}</dt>
            <dd>
              <TxLink
                tx={receiptField(transaction.tx)}
                {...(transaction.explorer === undefined ? {} : { explorer: transaction.explorer })}
              />
            </dd>
          </div>
        )}
      </dl>
      <CopyReceiptButton text={receiptText(receipt, kind)} />
    </section>
  );
}
