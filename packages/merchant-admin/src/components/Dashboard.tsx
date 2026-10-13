import type { DashboardState } from '../App';
import { About } from './About';
import { DashboardHeader } from './DashboardHeader';
import { OrdersSection } from './OrdersSection';
import { ProductsSection } from './ProductsSection';
import { StoreSection } from './StoreSection';
import { Totals } from './Totals';
import { Warnings } from './Warnings';

interface Props {
  state: DashboardState;
  onRefresh: () => void;
  onMore: () => void;
  onLogOut: () => void;
}

export function Dashboard({ state, onRefresh, onMore, onLogOut }: Props) {
  const { snapshot } = state;
  return (
    <div className="min-h-screen">
      <DashboardHeader
        pubkey={state.pubkey}
        name={state.store?.name}
        busy={state.busy}
        onRefresh={onRefresh}
        onLogOut={onLogOut}
      />
      <main className="mx-auto flex max-w-1200 flex-col gap-24 px-16 py-24">
        <p role="status" className="text-14 text-text-2">
          {state.status}
        </p>
        {snapshot !== undefined && (
          <>
            <Warnings texts={snapshot.warnings} />
            <Totals history={snapshot.history} />
            <OrdersSection snapshot={snapshot} busy={state.busy} onMore={onMore} />
            <ProductsSection products={snapshot.allProducts} />
            <StoreSection store={snapshot.store} />
          </>
        )}
        <About />
      </main>
    </div>
  );
}
