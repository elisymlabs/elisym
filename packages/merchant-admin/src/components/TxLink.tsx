import { short } from '../lib/core';
import { Icon } from './Icon';

interface Props {
  tx: string;
  /** The explorer page `pay-core` built: a link only when it is https. */
  explorer?: string;
  /** Show the whole id rather than its two ends. */
  full?: boolean;
}

export function TxLink({ tx, explorer, full = false }: Props) {
  const text = full ? tx : short(tx);
  if (explorer === undefined || !explorer.startsWith('https://')) {
    return (
      <span className={`font-mono ${full ? 'break-all' : 'whitespace-nowrap'}`} title={tx}>
        {text}
      </span>
    );
  }
  return (
    <a
      href={explorer}
      target="_blank"
      rel="noopener noreferrer"
      title={tx}
      className="text-text hover:text-accent-ink inline-flex items-center gap-4 font-mono underline decoration-current/30 underline-offset-2"
    >
      <span className={full ? 'break-all' : 'whitespace-nowrap'}>{text}</span>
      <Icon name="external" className="size-12 shrink-0" />
    </a>
  );
}
