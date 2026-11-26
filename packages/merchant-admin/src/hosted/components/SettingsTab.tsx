import { useState } from 'react';
import { STALE_RELOADED } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { SettingsForm } from './SettingsForm';
import { SuspendStore } from './SuspendStore';
import { WebhookSecret } from './WebhookSecret';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

/**
 * The store's settings (a save refused as stale reads them again and says
 * so), the webhook secret, and suspending the store.
 */
export function SettingsTab({ session, view, onChanged }: Props) {
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | undefined>(
    undefined,
  );
  const config = view.config;
  if (config === null) {
    return <Notice tone="warn">Your store has no settings yet. Reload the page.</Notice>;
  }
  return (
    <div className="flex flex-col gap-24">
      <SettingsForm
        key={config.revision}
        session={session}
        config={config}
        onSaved={() => {
          setNotice({ tone: 'info', text: 'Settings saved.' });
          onChanged();
        }}
        onStale={() => {
          setNotice({ tone: 'error', text: STALE_RELOADED });
          onChanged();
        }}
      />
      {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      <WebhookSecret session={session} view={view} onChanged={onChanged} />
      <SuspendStore session={session} view={view} onChanged={onChanged} />
    </div>
  );
}
