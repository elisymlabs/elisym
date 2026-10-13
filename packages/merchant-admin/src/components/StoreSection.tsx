import type { StoreView } from '../lib/core';
import { Section } from './Section';

interface Props {
  store: StoreView;
}

export function StoreSection({ store }: Props) {
  return (
    <Section title="Store">
      <dl
        id="store"
        className="rounded-12 border-line bg-surface text-14 grid grid-cols-1 gap-12 border p-16 sm:grid-cols-[160px_1fr]"
      >
        <dt className="text-text-2">Profile name</dt>
        <dd>{store.name ?? '(no profile name)'}</dd>
        <dt className="text-text-2">Inbox relays</dt>
        <dd className="text-13 flex flex-col gap-2 font-mono break-all">
          {store.relays.map((relay) => (
            <span key={relay}>{relay}</span>
          ))}
          {store.noInboxList && (
            <span className="text-text-2 font-sans">no inbox list: the default relays</span>
          )}
        </dd>
        <dt className="text-text-2">Payout networks</dt>
        <dd className="text-13 flex flex-col gap-2 font-mono">
          {store.payoutMediums.map((medium) => (
            <span key={medium}>{medium}</span>
          ))}
          {store.payoutMediums.length === 0 && (
            <span className="text-text-2 font-sans">no payout list found</span>
          )}
        </dd>
      </dl>
    </Section>
  );
}
