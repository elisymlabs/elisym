import { useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { saveSettings } from '../lib/save';
import { npubOf } from '../lib/signer';
import { EMPTY_FORM } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Section } from './Section';
import { StoreSettingsForm } from './StoreSettingsForm';

interface Props {
  deps: SessionDeps;
  /** The store, once created. */
  view: StoreView | undefined;
  onCreated: (view: StoreView) => void;
  onDone: () => Promise<void>;
  onSignOut: () => void;
}

/** Create the store, then sign its first config and key authorization in one step (7.3). */
export function Onboarding({ deps, view, onCreated, onDone, onSignOut }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ownerNpub = npubOf(deps.signer.pubkey);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      onCreated(await deps.api.createStore());
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-720 flex-col gap-20 px-16 py-32">
      <header className="flex items-center justify-between gap-12">
        <h1 className="text-24 font-semibold">Set up your assistant</h1>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <Notice tone="info">
        Your store starts as pending. It begins answering once the Askr operator activates it; there
        is nothing to pay here. You can finish the setup now and it goes live on activation.
      </Notice>
      {view === undefined ? (
        <Section
          title="1. Create your store"
          description="This sets up your assistant and a product key on the Askr server for this owner key."
        >
          <p className="text-13 text-text-3 font-mono break-all">{ownerNpub}</p>
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? 'Creating...' : 'Create my store'}
            </button>
          </div>
        </Section>
      ) : (
        <Section
          title="2. Describe your store"
          description="You sign these settings with your owner key. They tell the assistant what to sell and where it may run."
        >
          <StoreSettingsForm
            initial={EMPTY_FORM}
            ownerNpub={ownerNpub}
            submitLabel="Sign and save"
            onSubmit={async (form) => {
              await saveSettings({ deps, view, form });
              await onDone();
              return 'Saved.';
            }}
          />
        </Section>
      )}
    </main>
  );
}
