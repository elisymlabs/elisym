import type { TrustLevel } from '@elisym/commerce';
import { useState } from 'preact/hooks';

interface Props {
  level: TrustLevel;
  domain: string | undefined;
}

/** What the trust level means, restated: it never adds trust the offer does not have. */
function explanation(level: TrustLevel, domain: string | undefined): string {
  switch (level) {
    case 'A':
      return `${domain ?? 'The store’s domain'} confirms this store’s keys.`;
    case 'B':
      return 'The store has a hosted name, but no website of its own vouches for it.';
    case 'C':
      return 'No website vouches for this store. Pay only if you trust this page.';
  }
}

function chipLabel(level: TrustLevel, domain: string | undefined): string {
  switch (level) {
    case 'A':
      return domain === undefined ? 'Verified store' : `Verified: ${domain}`;
    case 'B':
      return 'Named store';
    case 'C':
      return 'Unverified store';
  }
}

export function TrustChip({ level, domain }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div class="trust">
      <button
        type="button"
        class="chip"
        data-level={level}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {chipLabel(level, domain)}
      </button>
      {open ? <p class="trust-detail">{explanation(level, domain)}</p> : null}
    </div>
  );
}
