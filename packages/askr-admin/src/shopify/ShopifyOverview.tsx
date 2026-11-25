import { Notice } from '../components/Notice';
import { Section } from '../components/Section';
import type { ShopifyApi } from './api';
import { themeEditorUrl } from './bridge';
import { ShopifyPlan } from './ShopifyPlan';
import type { ShopifyView } from './types';

interface Props {
  api: ShopifyApi;
  view: ShopifyView;
  apiKey: string;
  onView: (view: ShopifyView) => void;
}

type Store = NonNullable<ShopifyView['store']>;

function statusLine(store: Store): string {
  if (store.status === 'active') {
    return 'Your assistant is live on your store.';
  }
  if (store.status === 'suspended') {
    return 'Your assistant is paused. Contact us to turn it back on.';
  }
  return 'Your assistant is set up. Choose a plan to turn it on.';
}

function syncLine(store: Store): string {
  const connector = store.connector;
  if (connector === null) {
    return 'Products are not connected.';
  }
  if (!connector.enabled) {
    return 'Product sync is off while the app is not active.';
  }
  if (connector.lastRunAt === null) {
    return 'Products are read from your Shopify catalog once the assistant is on.';
  }
  const status = connector.lastStatus;
  const ok =
    typeof status === 'object' && status !== null && Reflect.get(status, 'status') === 'ok';
  const at = new Date(connector.lastRunAt).toLocaleString();
  return ok ? `Products last synced ${at}.` : `The last product sync, ${at}, did not finish.`;
}

/** Where the store stands (askr-shopify 5.2): status, product sync, and the theme embed. */
export function ShopifyOverview({ api, view, apiKey, onView }: Props) {
  const store = view.store;
  if (store === null) {
    return null;
  }
  return (
    <div className="flex flex-col gap-24">
      <Section title="Status">
        <p className="text-14">{statusLine(store)}</p>
        <p className="text-14 text-text-2">{syncLine(store)}</p>
      </Section>
      <ShopifyPlan api={api} view={view} onView={onView} />
      <Section
        title="Show it on your store"
        description="Turn on the Askr assistant in your theme editor. It appears on every page of your storefront."
      >
        <div>
          <a className="btn" href={themeEditorUrl(view.shop, apiKey)} target="_top">
            Open the theme editor
          </a>
        </div>
      </Section>
      {store.delegation.inCharge ? null : (
        <Notice tone="info">
          You manage this store with your own owner key in the Askr admin. Billing, product sync and
          the theme embed keep working here.
        </Notice>
      )}
    </div>
  );
}
