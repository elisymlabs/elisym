import { TxLink } from './TxLink';

interface Props {
  label: string;
  tx: string;
  explorer?: string;
}

/** "Transaction: 34DGcs…NM5B ↗", linked only to an `https:` explorer page. */
export function TransactionLine({ label, tx, explorer }: Props) {
  return (
    <span class="receipt-line">
      {`${label}: `}
      <TxLink tx={tx} {...(explorer === undefined ? {} : { explorer })} />
    </span>
  );
}
