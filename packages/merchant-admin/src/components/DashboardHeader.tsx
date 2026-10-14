import * as nip19 from 'nostr-tools/nip19';
import { PAGE_FRAME, PRODUCT_NAME } from '../constants';
import { short } from '../lib/core';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import { LogoMark } from './LogoMark';
import { StatusLine } from './StatusLine';

interface Props {
  pubkey: string;
  name?: string;
  status: string;
  busy: boolean;
  onRefresh: () => void;
  onLogOut: () => void;
}

/** The store this key opens, so the merchant sees it is the right one before trusting the numbers. */
export function DashboardHeader({ pubkey, name, status, busy, onRefresh, onLogOut }: Props) {
  const npub = nip19.npubEncode(pubkey);
  return (
    <div className={`${PAGE_FRAME} flex min-h-64 flex-wrap items-center gap-x-16 gap-y-12 py-12`}>
      <span className="flex items-center gap-10" title={PRODUCT_NAME}>
        <LogoMark className="size-28" />
        <span className="text-15 hidden font-semibold tracking-tight md:inline">
          {PRODUCT_NAME}
        </span>
      </span>
      <span aria-hidden="true" className="bg-line hidden h-24 w-1 md:block" />
      <div className="min-w-0 flex-1">
        <p id="store-name" className="text-15 truncate font-semibold">
          {name ?? '(no profile name)'}
        </p>
        <p className="text-12 text-text-3 flex h-18 items-center gap-2 font-mono">
          <span id="store-pubkey" title={npub}>
            {short(npub)}
          </span>
          <CopyButton text={npub} label="Copy npub" />
        </p>
      </div>
      <StatusLine status={status} busy={busy} />
      <div className="flex items-center gap-8">
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="rounded-10 border-line bg-surface text-14 hover:bg-surface-2 flex items-center gap-6 border px-12 py-8 font-medium disabled:opacity-50"
        >
          <Icon name="refresh" className={`size-16 ${busy ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        <button
          type="button"
          onClick={onLogOut}
          className="rounded-10 bg-ink text-14 text-ink-text flex items-center gap-6 px-12 py-8 font-medium hover:opacity-90"
        >
          <Icon name="logout" className="size-16" />
          Log out
        </button>
      </div>
    </div>
  );
}
