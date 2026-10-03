import type { Receipt } from '../session';
import { CopyText } from './CopyText';
import { receiptText } from './text';

interface Props {
  receipt: Receipt;
  kind: 'delivered' | 'refunded';
}

/**
 * What the order was, as one plain-text block: the same text is shown and
 * copied. The transaction link only when this checkout saw the payment, and
 * only to an `https:` explorer page.
 */
export function ReceiptBlock({ receipt, kind }: Props) {
  const explorer = receipt.paid?.explorer;
  return (
    <section class="receipt" aria-label="Receipt">
      <p class="receipt-title">Receipt</p>
      <CopyText
        text={receiptText(receipt, kind)}
        label="Copy receipt"
        copiedText="Receipt copied."
        textClass="receipt-text"
      />
      {explorer === undefined ? null : (
        <p>
          <a href={explorer} target="_blank" rel="noopener noreferrer">
            View transaction
          </a>
        </p>
      )}
    </section>
  );
}
