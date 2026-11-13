import type { Snapshot } from '../lib/core';
import { CREDITOR, type Source } from '../lib/source';
import { Charts } from './Charts';
import { RecentOrders } from './RecentOrders';
import { Section } from './Section';
import { StoreSummary } from './StoreSummary';
import { Totals } from './Totals';
import { Warnings } from './Warnings';

interface Props {
  snapshot: Snapshot;
  onTab: (tab: 'orders' | 'products' | 'store') => void;
  source?: Source;
}

export function Overview({ snapshot, onTab, source = 'self-hosted' }: Props) {
  return (
    <div className="flex flex-col gap-24">
      <Warnings texts={snapshot.warnings} />
      <Section
        title="Overview"
        heading="h1"
        description={`Credited totals count only what ${CREDITOR[source]} confirmed on chain, over the loaded orders.`}
      >
        <Totals history={snapshot.history} source={source} />
      </Section>
      <Charts
        rows={snapshot.history.rows}
        nowSeconds={Math.floor(Date.now() / 1000)}
        source={source}
      />
      <RecentOrders rows={snapshot.history.rows} onViewAll={() => onTab('orders')} />
      <StoreSummary
        snapshot={snapshot}
        onProducts={() => onTab('products')}
        onStore={() => onTab('store')}
      />
    </div>
  );
}
