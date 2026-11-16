import { type StorePrivateConfig, buildCatalogAuth, parseConfig } from '@elisym/askr';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type SessionDeps, postSigned } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { readAuthority } from '../lib/store-data';
import { authorizationOf, formOfConfig, signStoreEvents } from '../lib/store-form';
import { ownSignedEvents } from '../lib/stored-events';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  /** Signed: the store reloads and shows the dashboard. */
  onDone: () => Promise<void>;
  /** The previous settings could not be found: the merchant fills them in again. */
  onNoSettings: () => void;
  onSignOut: () => void;
}

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
 * The last step of replacing the secret key (K20): the settings and catalog
 * authorizations the previous key signed are signed again with the new one.
 * Runs on its own once; an interrupted move resumes here at the next sign-in.
 */
export function FinishMove({ deps, view, onDone, onNoSettings, onSignOut }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  const finish = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const moved = await deps.api.movedSettings();
      const [event] = ownSignedEvents([moved.config], moved.from);
      const config = event === undefined ? undefined : parseConfig(event);
      if (config === undefined) {
        onNoSettings();
        return;
      }
      const form = formOfConfig(config, privatePartOf(moved.private));
      const now = deps.now();
      const events = await signStoreEvents({
        form,
        keys: { assistant: view.assistant, serverKey: view.catalogKey },
        signer: deps.signer,
        now,
      });
      // Every other catalog key the previous key authorized keeps publishing for the store.
      const source = authorizationOf(form, view.catalogKey).key;
      const authority = await readAuthority(deps.reader, moved.from, now);
      for (const [key, roles] of authority.keys) {
        if (key !== source && roles.has('catalog')) {
          events.push(
            await deps.signer.signEvent(
              buildCatalogAuth({
                key,
                mode: key === view.catalogKey ? 'hosted' : 'self-host',
                createdAt: now,
              }),
            ),
          );
        }
      }
      await postSigned(deps, events);
      await onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [deps, view, onDone, onNoSettings]);

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void finish();
    }
  }, [finish]);

  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Moving your store to the new key</h1>
      <p className="text-15 text-text-2">
        Your store is yours again. Your settings are being signed with your new secret key; your
        products, policies and chat code stay as they are.
      </p>
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      <div className="flex gap-8">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void finish()}
        >
          {busy ? 'Signing...' : 'Retry'}
        </button>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}
