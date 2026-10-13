import * as nip19 from 'nostr-tools/nip19';
import { short } from '../lib/core';
import { CopyButton } from './CopyButton';

interface Props {
  pubkey: string;
  name?: string;
  busy: boolean;
  onRefresh: () => void;
  onLogOut: () => void;
}

/** The store this key opens, so the merchant sees it is the right one before trusting the numbers. */
export function DashboardHeader({ pubkey, name, busy, onRefresh, onLogOut }: Props) {
  const npub = nip19.npubEncode(pubkey);
  return (
    <header className="border-line bg-surface/90 sticky top-0 z-10 border-b backdrop-blur">
      <div className="mx-auto flex max-w-1200 flex-wrap items-center gap-12 px-16 py-12">
        <div className="min-w-0 flex-1">
          <p id="store-name" className="text-16 truncate font-semibold">
            {name ?? '(no profile name)'}
          </p>
          <p className="text-12 text-text-2 flex items-center gap-6 font-mono">
            <span id="store-pubkey" title={npub}>
              {short(npub)}
            </span>
            <CopyButton text={npub} label="Copy npub" />
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="rounded-8 border-line text-14 hover:bg-surface-2 border px-14 py-8 disabled:opacity-50"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onLogOut}
          className="rounded-8 bg-accent text-14 text-accent-text px-14 py-8 font-medium hover:opacity-90"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
