import * as nip19 from 'nostr-tools/nip19';
import { useState } from 'react';
import type { DashboardState } from '../App';
import { About } from './About';
import { DashboardShell, type ShellPage } from './DashboardShell';
import { EmptyState } from './EmptyState';
import type { IconName } from './Icon';
import { LoadingOverview } from './LoadingOverview';
import { OrdersSection } from './OrdersSection';
import { Overview } from './Overview';
import { ProductsSection } from './ProductsSection';
import { StoreSection } from './StoreSection';

interface Props {
  state: DashboardState;
  onRefresh: () => void;
  onMore: () => void;
  onLogOut: () => void;
}

type Page = 'overview' | 'orders' | 'products' | 'store' | 'help';

const PAGES: { id: Page; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'orders', label: 'Orders', icon: 'receipt' },
  { id: 'products', label: 'Products', icon: 'box' },
  { id: 'store', label: 'Store', icon: 'store' },
  { id: 'help', label: 'Help', icon: 'help' },
];

interface NotReadProps {
  busy: boolean;
}

/** Before the first read lands: placeholders while it runs, a way out when it failed. */
function NotRead({ busy }: NotReadProps) {
  if (busy) {
    return <LoadingOverview />;
  }
  return (
    <div className="rounded-16 border-line bg-surface border">
      <EmptyState icon="alert" title="Your store could not be read">
        The status in the sidebar says why. Press Refresh to read it again.
      </EmptyState>
    </div>
  );
}

/** The self-hosted store's pages, read from its relays, on the admin's frame. */
export function Dashboard({ state, onRefresh, onMore, onLogOut }: Props) {
  const [page, setPage] = useState<Page>('overview');
  const { snapshot } = state;
  const contentOf = (id: Page) => {
    if (id === 'help') {
      return <About />;
    }
    if (snapshot === undefined) {
      return <NotRead busy={state.busy} />;
    }
    switch (id) {
      case 'overview':
        return <Overview snapshot={snapshot} onTab={setPage} />;
      case 'orders':
        return <OrdersSection snapshot={snapshot} busy={state.busy} onMore={onMore} />;
      case 'products':
        return <ProductsSection products={snapshot.allProducts} />;
      case 'store':
        return <StoreSection store={snapshot.store} pubkey={snapshot.storePubkey} />;
    }
  };
  const counts: Partial<Record<Page, number>> =
    snapshot === undefined
      ? {}
      : {
          orders: snapshot.history.rows.length,
          products: snapshot.allProducts?.lines.length ?? 0,
        };
  const pages: ShellPage[] = PAGES.map((each) => ({
    ...each,
    ...(counts[each.id] === undefined ? {} : { count: counts[each.id] }),
    content: contentOf(each.id),
  }));
  return (
    <DashboardShell
      name={state.store?.name}
      unnamed="(no profile name)"
      identity={{ value: nip19.npubEncode(state.pubkey), copyLabel: 'Copy npub' }}
      status={state.status}
      busy={state.busy}
      onRefresh={onRefresh}
      onSignOut={onLogOut}
      signOutLabel="Log out"
      pages={pages}
      active={page}
      onSelect={(id) => setPage(PAGES.find((each) => each.id === id)?.id ?? 'overview')}
    />
  );
}
