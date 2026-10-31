import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explain, explainAnswer } from '../lib/errors';
import type { OwnerTools } from '../lib/owner-tools';
import type { CheckoutReturn } from '../lib/start';
import { type StoreView, storeViewOf } from '../lib/store-view';
import { BillingPanel } from './BillingPanel';
import { Card } from './Card';
import { ExportPanel } from './ExportPanel';
import { HandoverPanel } from './HandoverPanel';
import { OrdersPanel } from './OrdersPanel';
import { SalePanel } from './SalePanel';
import { SetupFlow } from './SetupFlow';
import { StoreSetup } from './StoreSetup';
import { StoreSummary } from './StoreSummary';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  npub: string;
  pubkey: string;
  billingUrl: string | undefined;
  navigate: (url: string) => void;
  /** How a Stripe Checkout came back, when the console was opened from it. */
  checkoutReturn: CheckoutReturn | undefined;
  tools: OwnerTools;
}

/** How often the store is read while an export runs. */
const EXPORT_READ_MS = 5000;

const CHECKOUT_NOTICE: Record<CheckoutReturn['outcome'], string> = {
  done: 'Card payment received: it shows here once Stripe confirms it, usually within a minute. Refresh to see it.',
  cancelled: 'Card checkout was cancelled: nothing was charged.',
};

/**
 * The signed-in owner's store: its summary, its billing and its launch. A
 * reload keeps the view it has until a newer one arrives; only the newest
 * answer counts, and none after the store left the page.
 */
export function Store({
  api,
  tenantId,
  npub,
  pubkey,
  billingUrl,
  navigate,
  checkoutReturn,
  tools,
}: Props) {
  const [view, setView] = useState<StoreView | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // Only this store's return, and only until the merchant reads the store again.
  const [notice, setNotice] = useState(
    checkoutReturn?.tenantId === tenantId ? checkoutReturn.outcome : undefined,
  );
  const latest = useRef(0);
  // The owner confirmed its own node: the cloud's copy is gone, and this key owns nothing here.
  const [destroyed, setDestroyed] = useState(false);

  const load = useCallback(async () => {
    latest.current += 1;
    const asked = latest.current;
    setLoading(true);
    const answer = await api.request('GET', `/tenants/${tenantId}`);
    if (asked !== latest.current) {
      return;
    }
    setLoading(false);
    const read = answer.status === 200 ? storeViewOf(answer.body) : undefined;
    if (read !== undefined) {
      setView(read);
      setError('');
    } else if (answer.status === 200) {
      setError(explain(undefined, answer.status));
    } else {
      setError(explainAnswer(answer.body, answer.status));
    }
  }, [api, tenantId]);

  useEffect(() => {
    void load();
    return () => {
      // No answer counts once the store has left the page.
      latest.current += 1;
    };
  }, [load]);

  // While an export runs, the store is read again until it shows as exported.
  const exporting = view?.exporting === true && view.exported === undefined;
  useEffect(() => {
    if (!exporting) {
      return;
    }
    const timer = setInterval(() => void load(), EXPORT_READ_MS);
    return () => clearInterval(timer);
  }, [exporting, load]);

  if (destroyed) {
    return (
      <Card title="Your store">
        <p role="status" className="text-14 mt-12">
          Destroyed: the cloud keeps nothing of this store any more, and your owner key is free.
        </p>
      </Card>
    );
  }

  return (
    <>
      {notice === undefined ? null : (
        <p role="status" className="rounded-12 bg-surface-2 text-14 w-full p-16">
          {CHECKOUT_NOTICE[notice]}
        </p>
      )}
      <Card title="Your store">
        {view === undefined && loading ? (
          <p className="text-14 text-text-3 mt-12">Loading...</p>
        ) : null}
        {error === '' ? null : (
          <p role="alert" className="text-14 text-error mt-12">
            {error}
          </p>
        )}
        {view === undefined ? null : <StoreSummary tenantId={tenantId} view={view} />}
        <Button
          disabled={loading}
          onClick={() => {
            setNotice(undefined);
            void load();
          }}
          className="mt-16"
        >
          Refresh
        </Button>
      </Card>
      {view?.exported === undefined ? null : (
        <HandoverPanel
          api={api}
          tenantId={tenantId}
          exported={view.exported}
          download={tools.download}
          onStoreChanged={() => void load()}
          onDestroyed={() => setDestroyed(true)}
        />
      )}
      {view === undefined || view.exported !== undefined || view.activated ? null : (
        <SetupFlow
          api={api}
          tenantId={tenantId}
          view={view}
          npub={npub}
          ownerPubkey={pubkey}
          tools={tools}
          billingUrl={billingUrl}
          navigate={navigate}
          onStoreChanged={() => void load()}
        />
      )}
      {view === undefined || view.exported !== undefined || !view.activated ? null : (
        <>
          <StoreSetup
            api={api}
            tenantId={tenantId}
            ownerPubkey={pubkey}
            network={view.network}
            tools={tools}
            activated={view.activated}
            withdrawn={view.withdrawn}
            onStoreChanged={() => void load()}
          />
          <BillingPanel
            api={api}
            tenantId={tenantId}
            view={view}
            billingUrl={billingUrl}
            navigate={navigate}
            onStale={() => void load()}
          />
          {view.activated && (view.network === 'mainnet' || view.network === 'devnet') ? (
            <OrdersPanel
              api={api}
              tenantId={tenantId}
              network={view.network}
              download={tools.download}
            />
          ) : null}
          {view.activated ? (
            <>
              <SalePanel
                api={api}
                tenantId={tenantId}
                view={view}
                onStoreChanged={() => void load()}
              />
              <ExportPanel
                api={api}
                tenantId={tenantId}
                view={view}
                onStoreChanged={() => void load()}
              />
            </>
          ) : null}
        </>
      )}
    </>
  );
}
