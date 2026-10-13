import { type ReactNode, useState } from 'react';
import type { DashboardState } from '../App';
import { About } from './About';
import { DashboardHeader } from './DashboardHeader';
import { EmptyState } from './EmptyState';
import { LoadingOverview } from './LoadingOverview';
import { OrdersSection } from './OrdersSection';
import { Overview } from './Overview';
import { ProductsSection } from './ProductsSection';
import { StoreSection } from './StoreSection';
import { type Tab, TabBar } from './TabBar';

interface Props {
  state: DashboardState;
  onRefresh: () => void;
  onMore: () => void;
  onLogOut: () => void;
}

interface PanelProps {
  tab: Tab;
  active: Tab;
  children: ReactNode;
}

/** A tab's panel: every panel stays mounted, so filters and open rows survive a tab switch. */
function Panel({ tab, active, children }: PanelProps) {
  return (
    <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} hidden={tab !== active}>
      {children}
    </div>
  );
}

interface NotReadProps {
  tab: Tab;
  busy: boolean;
}

/** Before the first read lands: placeholders while it runs, a way out when it failed. */
function NotRead({ tab, busy }: NotReadProps) {
  if (tab === 'help') {
    return <About />;
  }
  if (busy) {
    return <LoadingOverview />;
  }
  return (
    <div className="rounded-16 border-line bg-surface border">
      <EmptyState icon="alert" title="Your store could not be read">
        The status at the top says why. Press Refresh to read it again.
      </EmptyState>
    </div>
  );
}

export function Dashboard({ state, onRefresh, onMore, onLogOut }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const { snapshot } = state;
  const counts =
    snapshot === undefined
      ? {}
      : {
          orders: snapshot.history.rows.length,
          products: snapshot.allProducts?.lines.length ?? 0,
        };
  // A switch from a button inside a panel would hide the focused button: focus moves to the tab.
  const select = (next: Tab) => {
    setTab(next);
    window.scrollTo?.({ top: 0 });
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <div className="min-h-screen">
      <header className="border-line bg-bg/85 sticky top-0 z-10 border-b backdrop-blur-md">
        <DashboardHeader
          pubkey={state.pubkey}
          name={state.store?.name}
          status={state.status}
          busy={state.busy}
          onRefresh={onRefresh}
          onLogOut={onLogOut}
        />
        <TabBar active={tab} counts={counts} panels={snapshot !== undefined} onSelect={select} />
      </header>
      <main className="mx-auto max-w-1200 px-16 py-24 sm:px-24 sm:py-32">
        {snapshot === undefined ? (
          <NotRead tab={tab} busy={state.busy} />
        ) : (
          <>
            <Panel tab="overview" active={tab}>
              <Overview snapshot={snapshot} onTab={select} />
            </Panel>
            <Panel tab="orders" active={tab}>
              <OrdersSection snapshot={snapshot} busy={state.busy} onMore={onMore} />
            </Panel>
            <Panel tab="products" active={tab}>
              <ProductsSection products={snapshot.allProducts} />
            </Panel>
            <Panel tab="store" active={tab}>
              <StoreSection store={snapshot.store} pubkey={snapshot.storePubkey} />
            </Panel>
            <Panel tab="help" active={tab}>
              <About />
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
