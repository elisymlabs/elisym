import { short } from '../lib/core';

interface Props {
  tx: string;
  /** The explorer page `pay-core` built: a link only when it is https. */
  explorer?: string;
}

export function TxLink({ tx, explorer }: Props) {
  if (explorer === undefined || !explorer.startsWith('https://')) {
    return (
      <span className="font-mono" title={tx}>
        {short(tx)}
      </span>
    );
  }
  return (
    <a
      href={explorer}
      target="_blank"
      rel="noopener noreferrer"
      title={tx}
      className="font-mono underline underline-offset-2"
    >
      {short(tx)}
    </a>
  );
}
