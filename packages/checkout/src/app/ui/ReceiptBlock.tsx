import type { Receipt } from '../session';
import { CopyText } from './CopyText';
import { receiptText } from './text';

interface Props {
  receipt: Receipt;
  kind: 'delivered' | 'refunded';
}

/**
 * What the order was, as one plain-text block: the same text is shown and
 * copied. A transaction link only to an `https:` explorer page: "View" for a
 * payment this checkout confirmed, "Look up" for one it only sent.
 */
export function ReceiptBlock({ receipt, kind }: Props) {
  let link: { href: string; text: string } | undefined;
  if (receipt.paid?.explorer !== undefined) {
    link = { href: receipt.paid.explorer, text: 'View transaction' };
  } else if (receipt.sent?.explorer !== undefined) {
    link = { href: receipt.sent.explorer, text: 'Look up the transaction' };
  }
  return (
    <section class="receipt" aria-label="Receipt">
      <p class="receipt-title">Receipt</p>
      <CopyText
        text={receiptText(receipt, kind)}
        label="Copy receipt"
        copiedText="Receipt copied."
        textClass="receipt-text"
      />
      {link === undefined ? null : (
        <p>
          <a href={link.href} target="_blank" rel="noopener noreferrer">
            {link.text}
          </a>
        </p>
      )}
    </section>
  );
}
