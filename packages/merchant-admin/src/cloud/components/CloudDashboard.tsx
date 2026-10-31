import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Charts } from '../../components/Charts';
import { DashboardShell, type ShellPage } from '../../components/DashboardShell';
import type { IconName } from '../../components/Icon';
import { RecentOrders } from '../../components/RecentOrders';
import { Section } from '../../components/Section';
import { Totals } from '../../components/Totals';
import { totalsOf } from '../../lib/core';
import type { ConsoleApi } from '../lib/api';
import { explain, explainAnswer } from '../lib/errors';
import { orderRowsOf } from '../lib/order-rows';
import type { OwnerTools } from '../lib/owner-tools';
import { domainOf, nip05Of } from '../lib/settings';
import type { CheckoutReturn } from '../lib/start';
import { type StoreView, storeViewOf } from '../lib/store-view';
import { useCloudOrders } from '../lib/use-cloud-orders';
import { useKeptStore } from '../lib/use-kept-store';
import { useStatus } from '../lib/use-status';
import { BillingPanel } from './BillingPanel';
import { Card } from './Card';
import { CloudAbout } from './CloudAbout';
import { CloudStoreSummary } from './CloudStoreSummary';
import { DomainPanel } from './DomainPanel';
import { ExportPanel } from './ExportPanel';
import { HandoverPanel } from './HandoverPanel';
import { InstallStep } from './InstallStep';
import { NotRead } from './NotRead';
import { OrdersPanel } from './OrdersPanel';
import { PayoutsPanel } from './PayoutsPanel';
import { ProductsForm } from './ProductsForm';
import { SalePanel } from './SalePanel';
import { SettingsPanel } from './SettingsPanel';
import { SetupFlow } from './SetupFlow';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  npub: string;
  pubkey: string;
  billingUrl: string | undefined;
  navigate: (url: string) => void;
  /** How a Stripe Checkout came back, when the admin was opened from it. */
  checkoutReturn: CheckoutReturn | undefined;
  tools: OwnerTools;
  onSignOut: () => void;
}

type Page =
  | 'overview'
  | 'orders'
  | 'products'
  | 'payouts'
  | 'install'
  | 'settings'
  | 'billing'
  | 'help';

const PAGES: { id: Page; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'orders', label: 'Orders', icon: 'receipt' },
  { id: 'products', label: 'Products', icon: 'box' },
  { id: 'payouts', label: 'Payouts', icon: 'wallet' },
  { id: 'install', label: 'Install', icon: 'code' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'billing', label: 'Plan & billing', icon: 'card' },
  { id: 'help', label: 'Help', icon: 'help' },
];

/** Before launch, the setup on Overview holds these: the pages open once the store is live. */
const SET_UP_FIRST = 'Opens once your store is live: finish the setup on Overview';

/** How often the store is read while an export runs. */
const EXPORT_READ_MS = 5000;

const CHECKOUT_NOTICE: Record<CheckoutReturn['outcome'], string> = {
  done: 'Card payment received: it shows here once Stripe confirms it, usually within a minute. Refresh to see it.',
  cancelled: 'Card checkout was cancelled: nothing was charged.',
};

const DESCRIPTIONS: Record<Page, string> = {
  overview: 'How your store stands, and what it sold.',
  orders: 'Every order of your store.',
  products: 'What your store sells.',
  payouts: 'The wallets your buyers pay.',
  install: 'Paste this into your site to sell there.',
  settings: 'Your store name, domain and webhook; taking it off sale; leaving the cloud.',
  billing: 'Your plan, and paying for it.',
  help: 'What each page does, and how to reach us.',
};

/**
 * A cloud store on the admin's frame (plan `admin-onboarding.md` 2.5): one
 * read of its view, status, kept store and orders serves every page; Refresh
 * reads all four again. Before launch, Overview holds the setup; an exported
 * store shows only its handover, a destroyed one only that it is gone.
 */
export function CloudDashboard({
  api,
  tenantId,
  npub,
  pubkey,
  billingUrl,
  navigate,
  checkoutReturn,
  tools,
  onSignOut,
}: Props) {
  const [view, setView] = useState<StoreView | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  // Only this store's return, and only until the merchant reads the store again.
  const [notice, setNotice] = useState(
    checkoutReturn?.tenantId === tenantId ? checkoutReturn.outcome : undefined,
  );
  // The owner confirmed its own node: the cloud's copy is gone, and this key owns nothing here.
  const [destroyed, setDestroyed] = useState(false);
  const latest = useRef(0);

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

  // A store that left the cloud has nothing more to read: its status and kept store are not asked.
  const gone = destroyed || view?.exported !== undefined;
  const poll = useStatus(api, tenantId, () => tools.localNow() * 1000, !gone);
  const kept = useKeptStore(api, tenantId, !gone);
  const launched = view?.activated === true && view.exported === undefined;
  const orders = useCloudOrders(api, tenantId, launched);

  // Launched here: the store publishes what it keeps, so the kept store and its status are read again.
  const wasLaunched = useRef<boolean | undefined>(undefined);
  const { reload: reloadKept } = kept;
  const { watch } = poll;
  useEffect(() => {
    if (view === undefined) {
      return;
    }
    if (wasLaunched.current === false && launched) {
      reloadKept();
      watch();
    }
    wasLaunched.current = launched;
  }, [view, launched, reloadKept, watch]);

  const refresh = () => {
    setNotice(undefined);
    void load();
    poll.watch();
    kept.reload();
    orders.reload();
  };

  const status = poll.status?.gone === false ? poll.status : undefined;
  const { read } = kept;
  const network =
    view?.network === 'mainnet' || view?.network === 'devnet' ? view.network : undefined;
  const domain = read === undefined ? undefined : domainOf(nip05Of(read.form.domain));
  const rows = orders.read === undefined ? [] : orderRowsOf(orders.read.orders);
  const onStoreChanged = () => void load();

  const summary =
    view === undefined ? null : (
      <CloudStoreSummary
        tenantId={tenantId}
        view={view}
        status={status}
        onCheckAgain={poll.expired ? poll.watch : undefined}
      />
    );

  const overview = (
    <Section title="Overview" heading="h1" description={DESCRIPTIONS.overview}>
      {notice === undefined ? null : (
        <p role="status" className="rounded-12 bg-surface-2 text-14 w-full p-16">
          {CHECKOUT_NOTICE[notice]}
        </p>
      )}
      {error === '' ? null : (
        <p role="alert" className="text-14 text-error">
          {error}
        </p>
      )}
      {view === undefined && loading ? <p className="text-14 text-text-3">Loading...</p> : null}
      {summary}
      {view === undefined || launched ? null : (
        <SetupFlow
          api={api}
          tenantId={tenantId}
          view={view}
          npub={npub}
          ownerPubkey={pubkey}
          tools={tools}
          billingUrl={billingUrl}
          navigate={navigate}
          onStoreChanged={onStoreChanged}
          poll={poll}
          kept={kept}
        />
      )}
      {launched && orders.error !== '' ? (
        <p role="alert" className="text-14 text-error">
          {orders.error}
        </p>
      ) : null}
      {/* Charts only over orders read: a failed read is never shown as no orders. */}
      {launched && orders.read !== undefined ? (
        <>
          <Totals history={{ rows, totals: totalsOf(rows) }} source="cloud" />
          <Charts rows={rows} nowSeconds={Math.floor(Date.now() / 1000)} source="cloud" />
          <RecentOrders rows={rows} onViewAll={() => setPage('orders')} />
        </>
      ) : null}
    </Section>
  );

  let ordersPage: ReactNode;
  if (network === undefined) {
    ordersPage = (
      <Section title="Orders" heading="h1">
        <p className="text-14 text-text-2">No orders here.</p>
      </Section>
    );
  } else {
    ordersPage = (
      <OrdersPanel
        api={api}
        tenantId={tenantId}
        network={network}
        orders={orders}
        download={tools.download}
      />
    );
  }

  // The store not read yet: its pages say why (or that it is loading), never that they wait for a launch.
  const viewNotRead = <NotRead problem={error} onRetry={() => void load()} />;

  const content: Record<Page, ReactNode> =
    view === undefined
      ? {
          overview,
          orders: viewNotRead,
          products: viewNotRead,
          payouts: viewNotRead,
          install: viewNotRead,
          settings: viewNotRead,
          billing: viewNotRead,
          help: <CloudAbout tenantId={tenantId} />,
        }
      : {
          overview,
          orders: ordersPage,
          products: (
            <Section title="Products" heading="h1" description={DESCRIPTIONS.products}>
              {status === undefined ? (
                <NotRead problem={poll.error} onRetry={poll.watch} />
              ) : (
                <ProductsForm
                  api={api}
                  tenantId={tenantId}
                  kept={kept}
                  status={status}
                  poll={poll}
                  published={view.activated}
                />
              )}
            </Section>
          ),
          payouts: (
            <Section title="Payouts" heading="h1" description={DESCRIPTIONS.payouts}>
              {read?.storePubkey === undefined || network === undefined ? (
                <NotRead problem={kept.readError} onRetry={kept.reload} />
              ) : (
                <PayoutsPanel
                  api={api}
                  tenantId={tenantId}
                  storePubkey={read.storePubkey}
                  network={network}
                  kept={kept}
                  tools={tools}
                  activated={view.activated}
                  withdrawn={view.withdrawn}
                  onStoreChanged={onStoreChanged}
                />
              )}
            </Section>
          ),
          install: (
            <Section title="Install" heading="h1" description={DESCRIPTIONS.install}>
              {read?.storePubkey !== undefined && read.productNames.length > 0 ? (
                <Card title="Sell on your page">
                  <div className="mt-16">
                    <InstallStep
                      storePubkey={read.storePubkey}
                      products={read.productNames}
                      relayHints={read.relayHints}
                      network={view.network}
                      loader={read.loader}
                    />
                  </div>
                </Card>
              ) : (
                <p className="text-14 text-text-2">Add a product first: its button is made here.</p>
              )}
            </Section>
          ),
          settings: (
            <Section title="Settings" heading="h1" description={DESCRIPTIONS.settings}>
              <Card title="Your store">
                <div className="mt-16">
                  <SettingsPanel api={api} tenantId={tenantId} kept={kept} />
                </div>
              </Card>
              {read !== undefined && domain !== undefined ? (
                <DomainPanel
                  api={api}
                  tenantId={tenantId}
                  domain={domain}
                  ownerPubkey={pubkey}
                  storePubkey={read.storePubkey}
                />
              ) : null}
              <SalePanel
                api={api}
                tenantId={tenantId}
                view={view}
                onStoreChanged={onStoreChanged}
              />
              <ExportPanel
                api={api}
                tenantId={tenantId}
                view={view}
                onStoreChanged={onStoreChanged}
              />
            </Section>
          ),
          billing: (
            <Section title="Plan & billing" heading="h1" description={DESCRIPTIONS.billing}>
              <BillingPanel
                api={api}
                tenantId={tenantId}
                view={view}
                billingUrl={billingUrl}
                navigate={navigate}
                onStale={onStoreChanged}
              />
            </Section>
          ),
          help: <CloudAbout tenantId={tenantId} />,
        };

  const pages: ShellPage[] = PAGES.map((each) => {
    // Before launch the setup on Overview holds every step; the other pages wait for it.
    const waits = view !== undefined && !launched && each.id !== 'overview' && each.id !== 'help';
    // A count only of orders read: a failed or pending read counts nothing.
    const counted = launched && orders.read !== undefined && orders.error === '';
    return {
      ...each,
      ...(each.id === 'orders' && counted ? { count: rows.length } : {}),
      ...(waits ? { locked: SET_UP_FIRST } : {}),
      content: waits ? null : content[each.id],
    };
  });

  let alone: ReactNode;
  if (destroyed) {
    alone = (
      <Card title="Your store">
        <p role="status" className="text-14 mt-12">
          Destroyed: the cloud keeps nothing of this store any more, and your access key is free.
        </p>
      </Card>
    );
  } else if (view?.exported !== undefined) {
    alone = (
      <HandoverPanel
        api={api}
        tenantId={tenantId}
        exported={view.exported}
        download={tools.download}
        onStoreChanged={onStoreChanged}
        onDestroyed={() => setDestroyed(true)}
      />
    );
  }

  return (
    <DashboardShell
      name={read?.form.name === '' || read === undefined ? undefined : read.form.name}
      unnamed="Your store"
      identity={{ value: npub, copyLabel: 'Copy your public id (safe to share)' }}
      status=""
      busy={loading}
      {...(destroyed ? {} : { onRefresh: refresh })}
      onSignOut={onSignOut}
      signOutLabel="Sign out"
      pages={pages}
      active={page}
      onSelect={(id) => setPage(PAGES.find((each) => each.id === id)?.id ?? 'overview')}
      {...(alone === undefined ? {} : { alone })}
    />
  );
}
