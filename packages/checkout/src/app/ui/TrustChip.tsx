import type { TrustLevel } from '@elisym/commerce';

interface Props {
  level: TrustLevel;
  domain: string | undefined;
}

/** A positive trust signal only: a store no domain or hosted name vouches for shows none. */
function chipLabel(level: TrustLevel, domain: string | undefined): string | undefined {
  switch (level) {
    case 'A':
      return domain === undefined ? 'Verified store' : `Verified: ${domain}`;
    case 'B':
      return 'Named store';
    case 'C':
      return undefined;
  }
}

/** The store's trust level, as a plain label: never adds trust the offer does not have. */
export function TrustChip({ level, domain }: Props) {
  const label = chipLabel(level, domain);
  if (label === undefined) {
    return null;
  }
  return (
    <span class="chip" data-level={level}>
      {label}
    </span>
  );
}
