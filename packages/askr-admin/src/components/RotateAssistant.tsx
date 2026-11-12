import { type StoreConfig, decryptPrivateConfigWith } from '@elisym/askr';
import { useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { npubOf } from '../lib/signer';
import { authorizationOf, formOfConfig, signStoreEvents } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { Section } from './Section';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  onChanged: () => Promise<void>;
}

/** Rotate the assistant key A (1.5): the server makes the next A, O re-signs the config naming it. */
export function RotateAssistant({ deps, view, config, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const rotate = async () => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const { nextAssistant } = await deps.api.rotateAssistant();
      if (typeof nextAssistant !== 'string') {
        throw new Error('The server did not return a new assistant key. Retry.');
      }
      if (config === undefined) {
        setDone(
          'A new assistant key is ready. Open Settings and save to sign settings that name it.',
        );
        await onChanged();
        return;
      }
      const privatePart = await decryptPrivateConfigWith(config, deps.signer.decrypt);
      if (privatePart === undefined) {
        throw new Error(
          'A new assistant key is ready, but the private instructions could not be decrypted. Open Settings, enter them again and save.',
        );
      }
      const form = formOfConfig(config, privatePart);
      const keys = { assistant: nextAssistant, serverKey: view.catalogKey };
      const events = await signStoreEvents({
        form,
        keys,
        signer: deps.signer,
        now: deps.now(),
        previousCreatedAt: config.createdAt,
        // Only the config changes: the source key's authorization stays as it is.
        authorized: new Set([authorizationOf(form, view.catalogKey).key]),
      });
      await deps.api.storeEvents(events);
      setDone(
        'Signed. The current assistant keeps answering until the relay has accepted the new settings; then the new one takes over.',
      );
      await onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Assistant key"
      description="Rotate it if you think it leaked. Your settings are signed again for the new key, and its private instructions are encrypted to it."
    >
      <dl className="text-14 grid grid-cols-[auto_1fr] gap-x-16 gap-y-4">
        <dt className="text-text-2">Current</dt>
        <dd className="truncate font-mono">{npubOf(view.assistant)}</dd>
        {view.nextAssistant === null ? null : (
          <>
            <dt className="text-text-2">Next</dt>
            <dd className="truncate font-mono">{npubOf(view.nextAssistant)}</dd>
          </>
        )}
      </dl>
      {view.nextAssistant === null ? null : (
        <Notice tone="info">
          A rotation is under way. It completes once settings naming the next key are published.
        </Notice>
      )}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {done === '' ? null : <Notice tone="success">{done}</Notice>}
      <div>
        <button type="button" className="btn" disabled={busy} onClick={() => void rotate()}>
          {view.nextAssistant === null ? 'Rotate assistant key' : 'Sign settings for the next key'}
        </button>
      </div>
    </Section>
  );
}
