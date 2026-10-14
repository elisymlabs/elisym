import type { Snapshot } from '../lib/core';
import { Charts } from './Charts';
import { RecentOrders } from './RecentOrders';
import { Section } from './Section';
import { StoreSummary } from './StoreSummary';
import { Totals } from './Totals';
import { Warnings } from './Warnings';

interface Props {
  snapshot: Snapshot;
  onTab: (tab: 'orders' | 'products' | 'store') => void;
}

export function Overview({ snapshot, onTab }: Props) {
  return (
    <div className="flex flex-col gap-24">
      <Warnings texts={snapshot.warnings} />
      <Section
        title="Overview"
        description="Credited totals count only what your node confirmed on chain, over the loaded orders."
      >
        <Totals history={snapshot.history} />
      </Section>
      <Charts rows={snapshot.history.rows} nowSeconds={Math.floor(Date.now() / 1000)} />
      <div className="grid gap-16 lg:grid-cols-[1.6fr_1fr]">
        <RecentOrders rows={snapshot.history.rows} onViewAll={() => onTab('orders')} />
        <StoreSummary
          snapshot={snapshot}
          onProducts={() => onTab('products')}
          onStore={() => onTab('store')}
        />
      </div>
    </div>
  );
}
