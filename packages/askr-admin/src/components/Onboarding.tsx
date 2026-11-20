import { useState } from 'react';
import { contactEmailOf } from '../lib/contact';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { saveSettings } from '../lib/save';
import { npubOf } from '../lib/signer';
import { EMPTY_FORM } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { ContactLinks } from './ContactLinks';
import { Notice } from './Notice';
import { Section } from './Section';
import { StoreSettingsForm } from './StoreSettingsForm';
import { TextField } from './TextField';

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
  const [typedEmail, setTypedEmail] = useState('');
  const email = contactEmailOf(typedEmail);
  const ownerNpub = npubOf(deps.signer.pubkey);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      onCreated(await deps.api.createStore(email));
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
        <span className="flex flex-col gap-4">
          <span>
            Save your settings, then choose a plan in Overview: Free starts at once, with nothing to
            pay. For a paid plan, message us with your Store ID.
          </span>
          <ContactLinks storeId={ownerNpub} />
        </span>
      </Notice>
      {view === undefined ? (
        <Section
          title="1. Create your store"
          description="This sets up your assistant on the Askr server for this Store ID."
        >
          <p className="text-13 text-text-3 font-mono break-all">{ownerNpub}</p>
          <TextField
            id="onboarding-email"
            label="Your email"
            value={typedEmail}
            placeholder="you@yourshop.com"
            hint="Where the Askr operator writes to you about your plan and account: when its budget runs out, or when your store is activated. Kept on the Askr server only, never published."
            onChange={setTypedEmail}
          />
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || email === undefined}
              onClick={() => void create()}
            >
              {busy ? 'Creating...' : 'Create my store'}
            </button>
          </div>
        </Section>
      ) : (
        <div className="flex flex-col gap-20">
          <div className="flex flex-col gap-2">
            <h2 className="text-18 font-semibold">2. Describe your store</h2>
            <p className="text-13 text-text-2">
              You sign these settings with your secret key. They tell the assistant what to sell and
              where it may run.
            </p>
          </div>
          <StoreSettingsForm
            initial={EMPTY_FORM}
            submitLabel="Sign and save"
            onSubmit={async (form) => {
              const outcome = await saveSettings({ deps, view, form });
              if (outcome.connectorError !== undefined) {
                throw new Error(outcome.connectorError);
              }
              await onDone();
              return 'Saved.';
            }}
          />
        </div>
      )}
    </main>
  );
}
