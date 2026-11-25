import { useCallback, useEffect, useState } from 'react';
import { Notice } from '../components/Notice';
import { errorMessage } from '../lib/errors';
import type { ShopifyApi } from './api';
import { OwnerKeyInfo } from './OwnerKeyInfo';
import { ShopifyOnboarding } from './ShopifyOnboarding';
import { ShopifyOverview } from './ShopifyOverview';
import { ShopifySettings } from './ShopifySettings';
import type { ShopifyView } from './types';

interface Props {
  api: ShopifyApi;
  /** The shop the page was opened for. */
  shop: string;
  apiKey: string;
}

type Tab = 'overview' | 'settings' | 'key';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'key', label: 'Owner key' },
];

/**
 * The Shopify app's embedded admin (askr-shopify 5): onboarding on the first open, then the
 * store's overview, its settings and what the owner key is for. Nothing is kept in browser
 * storage; every call carries a fresh App Bridge session token.
 */
export function ShopifyApp({ api, shop, apiKey }: Props) {
  const [view, setView] = useState<ShopifyView>();
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');

  const load = useCallback(() => {
    setError('');
    api.store().then(setView, (caught: unknown) => setError(errorMessage(caught)));
  }, [api]);

  useEffect(load, [load]);

  if (view === undefined) {
    return error === '' ? (
      <p className="text-14 p-24">Loading...</p>
    ) : (
      <div className="flex flex-col gap-12 p-24">
        <Notice tone="error">{error}</Notice>
        <div>
          <button type="button" className="btn" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const store = view.store;
  if (!view.onboarded || store === null || store.onboarding) {
    return (
      <main className="p-24">
        <ShopifyOnboarding api={api} shop={shop} onDone={setView} />
      </main>
    );
  }
  return (
    <main className="flex flex-col gap-24 p-24">
      <nav className="flex gap-8" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === tab ? 'btn' : 'btn btn-ghost'}
            aria-current={entry.id === tab ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      {tab === 'overview' ? <ShopifyOverview view={view} apiKey={apiKey} /> : null}
      {tab === 'settings' ? <ShopifySettings api={api} /> : null}
      {tab === 'key' ? <OwnerKeyInfo npub={store.npub} /> : null}
    </main>
  );
}
