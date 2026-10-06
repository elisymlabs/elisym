import { shortTx } from './text';

interface Props {
  tx: string;
  explorer?: string;
}

/** "34DGcs…NM5B ↗": a transaction shortened, linked only to an `https:` explorer page. */
export function TxLink({ tx, explorer }: Props) {
  const short = shortTx(tx);
  return explorer?.startsWith('https://') === true ? (
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
  );
}
