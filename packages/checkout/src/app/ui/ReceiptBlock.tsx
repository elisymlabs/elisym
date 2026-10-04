import type { Receipt } from '../session';
import { CopyText } from './CopyText';
import { receiptField, receiptText } from './text';
import { TransactionLine } from './TransactionLine';

interface Props {
  receipt: Receipt;
  kind: 'delivered' | 'refunded';
}

/** The line that starts the order id in the receipt text. */
const ORDER_LINE = 'Order: ';

/**
 * What the order was. "Copy receipt" copies the full text; the screen shows
 * the same rows with the transaction shortened, as the link to its explorer
 * page when there is an `https:` one: "Transaction" for a payment this
 * checkout confirmed, "Transaction sent" for one it only sent. A short note
 * under the order id says what it is for.
 */
export function ReceiptBlock({ receipt, kind }: Props) {
  const text = receiptText(receipt, kind);
  let transaction: { label: string; tx: string; explorer?: string } | undefined;
  if (receipt.paid !== undefined) {
    transaction = { label: 'Transaction', ...receipt.paid };
  } else if (receipt.sent !== undefined) {
    transaction = { label: 'Transaction sent', ...receipt.sent };
  }
  const lines = text.split('\n');
  // The transaction is the last line of the text: shown below in its short, linked form.
  const rows = transaction === undefined ? lines : lines.slice(0, -1);
  const shown = (
    <>
      {rows.map((line, row) => (
        <span key={row} class="receipt-line">
          {line}
          {line.startsWith(ORDER_LINE) ? (
            <span class="receipt-hint">Give this number to the store if you need help.</span>
          ) : null}
        </span>
      ))}
      {transaction === undefined ? null : (
        <TransactionLine
          label={transaction.label}
          tx={receiptField(transaction.tx)}
          {...(transaction.explorer === undefined ? {} : { explorer: transaction.explorer })}
        />
      )}
    </>
  );
  return (
    <section class="receipt" aria-label="Receipt">
      <p class="receipt-title">Receipt</p>
      <CopyText
        text={text}
        shown={shown}
        label="Copy receipt"
        copiedText="Receipt copied."
        textClass="receipt-text"
      />
    </section>
  );
}
