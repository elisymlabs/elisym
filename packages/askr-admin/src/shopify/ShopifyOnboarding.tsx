import { buildCatalogAuth, buildConfigDelegation } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { useState } from 'react';
import { CopyBlock } from '../components/CopyBlock';
import { DownloadKey } from '../components/DownloadKey';
import { Notice } from '../components/Notice';
import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { ShopifyApi } from './api';
import type { ShopifyView } from './types';

interface Props {
  api: ShopifyApi;
  shop: string;
  onDone: (view: ShopifyView) => void;
}

/** What onboarding holds between its steps: O (in memory only) and the two events it signed. */
interface Pending {
  ownerSecret: Uint8Array;
  events: NostrEvent[];
}

/**
 * The first open of the app (askr-shopify 3.3): the owner key O is made here, proves itself to
 * the server, signs the catalog key and the app's delegate, and is handed to the merchant as a
 * backup before anything is finished. O never leaves this tab and is dropped once done.
 */
export function ShopifyOnboarding({ api, shop, onDone }: Props) {
  const [pending, setPending] = useState<Pending>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const ownerSecret = generateSecretKey();
      const keys = await api.begin(shop, ownerSecret, await api.time());
      // Dated by the server's clock, so this device's clock never matters.
      const events = [
        finalizeEvent(
          buildCatalogAuth({ key: keys.catalogKey, mode: 'hosted', createdAt: keys.now }),
          ownerSecret,
        ),
        finalizeEvent(
          buildConfigDelegation({ key: keys.delegate, createdAt: keys.now }),
          ownerSecret,
        ),
      ];
      setSaved(false);
      setPending({ ownerSecret, events });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (pending === undefined) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const view = await api.finish(pending.events);
      setPending(undefined);
      onDone(view);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code.startsWith('onboarding_')) {
        // Replaced by another staff member's setup, or expired: start again with a new key.
        setPending(undefined);
        setError('This setup was replaced or expired. Start again: a new key will be made.');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  if (pending === undefined) {
    return (
      <div className="flex flex-col gap-16">
        <h1 className="text-20 font-semibold">Set up Askr for {shop}</h1>
        <p className="text-14 text-text-2 max-w-600">
          Askr answers your shoppers about your products and policies. Setting it up makes an owner
          key for your store here in your browser. Askr never sees it; you keep it as a backup.
        </p>
        {error === '' ? null : <Notice tone="error">{error}</Notice>}
        <div>
          <button type="button" className="btn" disabled={busy} onClick={() => void start()}>
            {busy ? 'Setting up...' : 'Set up Askr'}
          </button>
        </div>
      </div>
    );
  }
  const npub = npubEncode(getPublicKey(pending.ownerSecret));
  const nsec = nsecEncode(pending.ownerSecret);
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-20 font-semibold">Save your owner key</h1>
      <p className="text-14 text-text-2 max-w-600">
        This key is the root of your Askr store. You do not need it day to day: the app manages your
        store for you. Keep it to take the store over yourself, or to cut the app off, if you ever
        need to. Nobody can recover it for you.
      </p>
      <DownloadKey nsec={nsec} npub={npub} />
      <CopyBlock text={nsec} label="Owner key (secret)" />
      <label className="text-14 flex items-center gap-8">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        I saved my owner key somewhere safe
      </label>
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      <div>
        <button
          type="button"
          className="btn"
          disabled={!saved || busy}
          onClick={() => void finish()}
        >
          {busy ? 'Finishing...' : 'Finish setup'}
        </button>
      </div>
    </div>
  );
}
