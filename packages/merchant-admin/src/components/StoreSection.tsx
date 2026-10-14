import * as nip19 from 'nostr-tools/nip19';
import type { ReactNode } from 'react';
import type { StoreView } from '../lib/core';
import { CopyButton } from './CopyButton';
import { Section } from './Section';

interface Props {
  store: StoreView;
  /** The store's public key, hex. */
  pubkey?: string;
}

interface RowProps {
  label: string;
  hint: string;
  children: ReactNode;
}

function Row({ label, hint, children }: RowProps) {
  return (
    <div className="border-line grid gap-8 border-t px-20 py-16 first:border-t-0 sm:grid-cols-[220px_1fr] sm:gap-24">
      <dt className="flex flex-col gap-2">
        <span className="text-14 font-medium">{label}</span>
        <span className="text-12 text-text-3">{hint}</span>
      </dt>
      <dd className="text-14 min-w-0">{children}</dd>
    </div>
  );
}

export function StoreSection({ store, pubkey }: Props) {
  const npub = pubkey === undefined ? undefined : nip19.npubEncode(pubkey);
  return (
    <Section
      title="Store"
      description="What your node published for the store. Read-only: change it with your node."
    >
      <dl id="store" className="rounded-16 border-line bg-surface border">
        <Row label="Profile name" hint="Shown to buyers in the checkout">
          {store.name ?? '(no profile name)'}
        </Row>
        {npub !== undefined && (
          <Row label="Public key" hint="Your store's identity on Nostr">
            <span className="flex items-start gap-4">
              <span className="text-13 font-mono break-all">{npub}</span>
              <CopyButton text={npub} label="Copy npub" />
            </span>
          </Row>
        )}
        <Row label="Inbox relays" hint="Where buyers send orders">
          <span className="flex flex-col gap-6">
            {store.relays.map((relay) => (
              <span key={relay} className="text-13 font-mono break-all">
                {relay}
              </span>
            ))}
            {store.noInboxList && (
              <span className="text-13 text-text-2">no inbox list: the default relays</span>
            )}
          </span>
        </Row>
        <Row label="Payout networks" hint="Where buyers can pay you">
          <span className="flex flex-wrap gap-6">
            {store.payoutMediums.map((medium) => (
              <span key={medium} className="rounded-6 bg-surface-2 text-13 px-8 py-2 font-mono">
                {medium}
              </span>
            ))}
            {store.payoutMediums.length === 0 && (
              <span className="text-13 text-text-2">no payout list found</span>
            )}
          </span>
        </Row>
      </dl>
    </Section>
  );
}
