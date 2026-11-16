import { type StorePrivateConfig, parseConfig } from '@elisym/askr';
import { useCallback, useEffect, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { saveSettings } from '../lib/save';
import { npubOf } from '../lib/signer';
import { EMPTY_FORM, type StoreForm, formOfConfig } from '../lib/store-form';
import { ownSignedEvents } from '../lib/stored-events';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Section } from './Section';
import { StoreSettingsForm } from './StoreSettingsForm';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  /** Signed: the store reloads and shows the dashboard. */
  onDone: () => Promise<void>;
  onSignOut: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | {
      state: 'ready';
      form: StoreForm;
      /** The previous key's settings were not found: the form starts empty. */
      found: boolean;
      /** Found, but its private instructions could not be read. */
      privateLost: boolean;
    };

/** The private part as the server read it, if it has the expected shape. */
function privatePartOf(value: unknown): StorePrivateConfig | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const voice: unknown = Reflect.get(value, 'voice');
  const instructions: unknown = Reflect.get(value, 'instructions');
  const notes: unknown = Reflect.get(value, 'notes');
  return typeof voice === 'string' && typeof instructions === 'string' && typeof notes === 'string'
    ? { voice, instructions, notes }
    : undefined;
}

/**
 * The last step of replacing the secret key (K21): the settings the previous
 * key signed last, shown for review and signed with the new key. Nothing is
 * signed unasked: if someone else had the old key, the last settings may be
 * theirs. Only the product source's key is authorized again; other catalog
 * keys the old key authorized are left out, as one of them may be a thief's.
 */
export function FinishMove({ deps, view, onDone, onSignOut }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const read = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const moved = await deps.api.movedSettings();
      const [event] = ownSignedEvents([moved.config], moved.from);
      const config = event === undefined ? undefined : parseConfig(event);
      if (config === undefined) {
        setLoad({ state: 'ready', form: EMPTY_FORM, found: false, privateLost: false });
        return;
      }
      const privatePart = privatePartOf(moved.private);
      setLoad({
        state: 'ready',
        form: formOfConfig(config, privatePart),
        found: true,
        privateLost: privatePart === undefined,
      });
    } catch (failure) {
      setLoad({ state: 'failed', error: errorMessage(failure) });
    }
  }, [deps]);

  useEffect(() => {
    void read();
  }, [read]);

  let body;
  if (load.state === 'loading') {
    body = <p className="text-14 text-text-2">Reading your previous settings...</p>;
  } else if (load.state === 'failed') {
    body = (
      <Notice tone="error">
        {load.error}{' '}
        <button type="button" className="underline" onClick={() => void read()}>
          Retry
        </button>
      </Notice>
    );
  } else {
    body = (
      <Section
        title="Check and sign your settings"
        description={
          load.found
            ? 'These are the settings your previous key signed last. If someone else had that key, they may have changed them: fix anything that is not yours, then sign with your new key.'
            : 'Your previous settings could not be found. Fill them in again and sign with your new key.'
        }
      >
        {load.privateLost ? (
          <Notice tone="warn">
            Your private instructions could not be read, so they are empty below. Enter them again.
          </Notice>
        ) : null}
        {load.form.source === 'paycore' ? (
          <Notice tone="warn">
            Your products come from Pay Core, which must be linked to your new key with our help.
            Contact us once you have signed.
          </Notice>
        ) : null}
        <StoreSettingsForm
          initial={load.form}
          ownerNpub={npubOf(deps.signer.pubkey)}
          submitLabel="Sign with my new key"
          onSubmit={async (form) => {
            await saveSettings({ deps, view, form });
            await onDone();
            return 'Signed.';
          }}
        />
      </Section>
    );
  }

  return (
    <main className="mx-auto flex max-w-720 flex-col gap-20 px-16 py-32">
      <header className="flex items-center justify-between gap-12">
        <h1 className="text-24 font-semibold">Your store is on your new key</h1>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <Notice tone="info">
        Your products, policies, plan and chats stayed. Two things for your site: keep the
        askr-verification tag (or file) with your new Store ID there, as the connector checks it;
        and once you have signed, replace the chat code with the new one from the Embed tab. Until
        you sign, the chat on your site is unavailable; then the old code works again, but the new
        one no longer depends on your old key.
      </Notice>
      <Notice tone="info">
        Keys you authorized for your own backend or an agent are not carried over, since one may be
        someone else&apos;s. Authorize yours again under Advanced.
      </Notice>
      {body}
    </main>
  );
}
