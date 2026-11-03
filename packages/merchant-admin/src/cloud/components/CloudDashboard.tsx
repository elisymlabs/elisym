import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Charts } from '../../components/Charts';
import { DashboardShell, type ShellPage } from '../../components/DashboardShell';
import { EmptyState } from '../../components/EmptyState';
import type { IconName } from '../../components/Icon';
import { RecentOrders } from '../../components/RecentOrders';
import { Section } from '../../components/Section';
import { Totals } from '../../components/Totals';
import { totalsOf } from '../../lib/core';
import type { ApiAnswer, ConsoleApi } from '../lib/api';
import { explain, explainAnswer } from '../lib/errors';
import { orderRowsOf } from '../lib/order-rows';
import type { OwnerTools } from '../lib/owner-tools';
import { type CloudPage, pageLocks } from '../lib/page-locks';
import { domainOf, nip05Of } from '../lib/settings';
import type { CheckoutReturn } from '../lib/start';
import { type StoreView, storeViewOf } from '../lib/store-view';
import { type TierCard, tierCardsFrom } from '../lib/tiers';
import { useCloudOrders } from '../lib/use-cloud-orders';
import { useKeptStore } from '../lib/use-kept-store';
import { useStatus } from '../lib/use-status';
import { BillingPanel } from './BillingPanel';
import { Card } from './Card';
import { CloudAbout } from './CloudAbout';
import { CloudStoreSummary } from './CloudStoreSummary';
import { DomainPanel } from './DomainPanel';
import { ExportPanel } from './ExportPanel';
import { GettingStarted } from './GettingStarted';
import { HandoverPanel } from './HandoverPanel';
import { InstallStep } from './InstallStep';
import { NotRead } from './NotRead';
import { OrdersPanel } from './OrdersPanel';
import { PayoutsPanel } from './PayoutsPanel';
import { PlanChange } from './PlanChange';
import { PlanSummary } from './PlanSummary';
import { ProductsForm } from './ProductsForm';
import { SalePanel } from './SalePanel';
import { SettingsPanel } from './SettingsPanel';

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
  /** The plan catalog (`GET /tiers`, unsigned): the plan's price in words. */
  loadTiers: () => Promise<ApiAnswer>;
}

type Page = CloudPage;

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
  loadTiers,
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
  // Launched while this page was open: said once, and focus goes to the news.
  const [justLaunched, setJustLaunched] = useState(false);
  const liveLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (justLaunched) {
      liveLine.current?.focus();
    }
  }, [justLaunched]);
  // The plan catalog, once read (undefined: unread, or the catalog failed): prices and names.
  const [tiers, setTiers] = useState<TierCard[] | undefined>(undefined);
  const latest = useRef(0);

  useEffect(() => {
    let current = true;
    void loadTiers().then((answer) => {
      const cards = answer.status === 200 ? tierCardsFrom(answer.body) : undefined;
      if (current && cards !== undefined) {
        setTiers(cards);
      }
    });
    return () => {
      current = false;
    };
  }, [loadTiers]);

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
      setJustLaunched(true);
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

  // A store found gone (handed over meanwhile) locks nothing: each page says what it could not read.
  const locks: Partial<Record<Page, string>> =
    view === undefined || poll.status?.gone === true
      ? {}
      : pageLocks({ launched, invited: view.launch === 'operator', status });
  const price =
    view === undefined ? undefined : tiers?.find((card) => card.id === view.tier)?.price;

  const summary =
    view === undefined ? null : (
      <CloudStoreSummary
        view={view}
        status={status}
        price={price}
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
      {/* Mounted before it says anything, so a screen reader announces the news. */}
      <p
        ref={liveLine}
        role="status"
        tabIndex={-1}
        className={
          justLaunched && launched
            ? 'rounded-12 bg-ok-bg text-ok text-14 w-full p-16 font-medium outline-none'
            : 'sr-only'
        }
      >
        {justLaunched && launched ? 'Your store is live: buyers can pay on your site now.' : ''}
      </p>
      {view === undefined || launched ? null : (
        <GettingStarted
          api={api}
          tenantId={tenantId}
          view={view}
          npub={npub}
          billingUrl={billingUrl}
          navigate={navigate}
          onStoreChanged={onStoreChanged}
          poll={poll}
          kept={kept}
          locks={locks}
          onOpen={setPage}
        />
      )}
      {summary}
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
  if (network === undefined || !launched) {
    ordersPage = (
      <Section title="Orders" heading="h1" description={DESCRIPTIONS.orders}>
        <EmptyState icon="receipt" title="No orders yet">
          Orders show here once your store is live.{' '}
          <button
            type="button"
            onClick={() => setPage('overview')}
            className="text-accent-ink font-medium underline underline-offset-2"
          >
            Finish getting started
          </button>
        </EmptyState>
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
                  onSettled={poll.watch}
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
                  onSettled={poll.watch}
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
                <EmptyState icon="code" title="Nothing to install yet">
                  Each product gets its own button here.{' '}
                  <button
                    type="button"
                    onClick={() => setPage('products')}
                    className="text-accent-ink font-medium underline underline-offset-2"
                  >
                    Add a product
                  </button>
                </EmptyState>
              )}
            </Section>
          ),
          settings: (
            <Section title="Settings" heading="h1" description={DESCRIPTIONS.settings}>
              <SettingsPanel api={api} tenantId={tenantId} kept={kept} onSaved={poll.watch} />
              {read !== undefined && domain !== undefined ? (
                <DomainPanel
                  api={api}
                  tenantId={tenantId}
                  domain={domain}
                  ownerPubkey={pubkey}
                  storePubkey={read.storePubkey}
                />
              ) : null}
              {/* Sale and export are a live store's: before launch there is nothing to take off. */}
              {launched ? (
                <>
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
                </>
              ) : null}
            </Section>
          ),
          billing: (
            <Section title="Plan & billing" heading="h1" description={DESCRIPTIONS.billing}>
              <PlanSummary view={view} status={status} price={price}>
                <PlanChange
                  api={api}
                  tenantId={tenantId}
                  view={view}
                  tiers={tiers}
                  billingUrl={billingUrl}
                  loadTiers={loadTiers}
                  now={() => api.serverNow() ?? tools.localNow()}
                  onChanged={onStoreChanged}
                  onOpenPage={setPage}
                />
              </PlanSummary>
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
    // A page that would only fail says why instead (the lock table).
    const locked = locks[each.id];
    // A count only of orders read: a failed or pending read counts nothing.
    const counted = launched && orders.read !== undefined && orders.error === '';
    return {
      ...each,
      ...(each.id === 'orders' && counted ? { count: rows.length } : {}),
      ...(locked === undefined ? {} : { locked }),
      content: locked === undefined ? content[each.id] : null,
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
