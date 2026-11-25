import { useState } from 'react';
import { Notice } from '../components/Notice';
import { Section } from '../components/Section';
import { errorMessage } from '../lib/errors';
import type { ShopifyApi } from './api';
import type { ShopifyView } from './types';

interface Props {
  api: ShopifyApi;
  view: ShopifyView;
  onView: (view: ShopifyView) => void;
}

/**
 * The store's plan (askr-shopify 3.6, Free only in this version): a pending store starts on
 * Free here; paid plans through Shopify come later.
 */
export function ShopifyPlan({ api, view, onView }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const store = view.store;
  if (store === null) {
    return null;
  }
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      onView(await api.freePlan());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Plan">
      {store.status === 'pending' ? (
        <>
          <p className="text-14">Start on Free to turn your assistant on.</p>
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          <div>
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}>
              {busy ? 'Starting...' : 'Start on Free'}
            </button>
          </div>
        </>
      ) : (
        <p className="text-14">
          {store.tier === null ? 'No plan' : `Plan: ${store.tier}`}
          {store.status === 'suspended' ? ' (paused)' : ''}
        </p>
      )}
    </Section>
  );
}
