import { domainGuide } from '../lib/embed';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  view: StoreView;
}

export const WARN_REPIN =
  'Buyers who bought from your store before keep your current owner key pinned: after the move their checkout refuses the store until they pin the new key, as on a first purchase.';
export const WARN_PAYOUT_NOTICE =
  'For 72 hours after the move, buyers see that your payout list changed recently.';
export const WARN_ASKR =
  'If your current owner key also runs an Askr store selling these products, its Buy buttons stop once the move is done: the current key no longer authorizes this store. To sell them there again, replace your Askr secret key with the new owner key.';
export const WARN_DOMAIN =
  'Your domain names your current owner key in its nostr.json (or _elisym TXT record). Update it to the new owner key: from when the store switches to the new key until you do, the checkout refuses the store for every buyer (owner mismatch). This page shows the file for the new key once the move is done.';
export const WARN_FOREVER =
  'Your current owner key can never open a PayCore store again, and the move cannot be undone here.';

/** Whether the store's address (nip05) is on a domain of the merchant's own, which names O. */
export function namesOwnerOnDomain(view: StoreView): boolean {
  return domainGuide(view.config?.nip05, view.storePubkey, view.owner).kind === 'nostr_json';
}

/** What changes for buyers and other services once the store moves, read before the move. */
export function MoveWarnings({ view }: Props) {
  return (
    <div className="flex flex-col gap-8" id="move-warnings">
      <Notice tone="warn">{WARN_REPIN}</Notice>
      <Notice tone="warn">{WARN_PAYOUT_NOTICE}</Notice>
      <Notice tone="warn">{WARN_ASKR}</Notice>
      {namesOwnerOnDomain(view) ? <Notice tone="warn">{WARN_DOMAIN}</Notice> : null}
      <Notice tone="warn">{WARN_FOREVER}</Notice>
    </div>
  );
}
