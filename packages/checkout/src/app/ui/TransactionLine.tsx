import { shortTx } from './text';

interface Props {
  label: string;
  tx: string;
  explorer?: string;
}

/** "Transaction: 34DGcs…NM5B ↗", linked only to an `https:` explorer page. */
export function TransactionLine({ label, tx, explorer }: Props) {
  const short = shortTx(tx);
  return (
    <span class="receipt-line">
      {`${label}: `}
      {explorer?.startsWith('https://') === true ? (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          title={tx}
          aria-label={`View transaction ${short} on the explorer`}
        >
          {`${short} ↗`}
        </a>
      ) : (
        <span title={tx}>{short}</span>
      )}
    </span>
  );
}
