import { useState } from 'react';
import { STALE_RELOADED } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { Payout, StoreView } from '../lib/types';
import { Notice } from './Notice';
import { PayoutListSection } from './PayoutListSection';
import { PayoutsForm } from './PayoutsForm';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

/** The payout addresses (each proven by its wallet) and the payout list O signs from them. */
export function PayoutsTab({ session, view, onChanged }: Props) {
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | undefined>(
    undefined,
  );
  const [saved, setSaved] = useState<Payout[] | undefined>(undefined);
  const config = view.config;
  if (config === null) {
    return <Notice tone="warn">Your store has no settings yet. Reload the page.</Notice>;
  }
  return (
    <div className="flex flex-col gap-24">
      <PayoutsForm
        key={config.revision}
        session={session}
        config={config}
        onSaved={(_config, payouts) => {
          setSaved(payouts);
          setNotice({ tone: 'info', text: 'Payouts saved.' });
          onChanged();
        }}
        onStale={() => {
          setSaved(undefined);
          setNotice({ tone: 'error', text: STALE_RELOADED });
          onChanged();
        }}
      />
      {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      <PayoutListSection
        session={session}
        view={view}
        payouts={saved ?? config.draftPayouts}
        onChanged={onChanged}
      />
    </div>
  );
}
