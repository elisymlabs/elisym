import { useState } from 'react';
import type { Snapshot } from '../lib/core';
import { countText } from '../lib/count';
import { csvFileName, ordersCsv } from '../lib/csv';
import { downloadText } from '../lib/download';
import { type StateFilter, filterRows, stateCounts } from '../lib/orders';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { OrderFilters } from './OrderFilters';
import { OrderRowView } from './OrderRowView';
import { Section } from './Section';

interface Props {
  snapshot: Snapshot;
  busy: boolean;
  onMore: () => void;
}

const COLUMNS = ['Date', 'Order', 'Customer', 'Total', 'State', 'Credited by your node'];

export function OrdersSection({ snapshot, busy, onMore }: Props) {
  const { rows } = snapshot.history;
  const [state, setState] = useState<StateFilter>('all');
  const [query, setQuery] = useState('');
  const shown = filterRows(rows, state, query);
  const filtered = shown.length !== rows.length;
  const exportCsv = () =>
    downloadText(
      document,
      ordersCsv(rows),
      csvFileName(snapshot.storePubkey, new Date()),
      'text/csv;charset=utf-8',
    );
  return (
    <Section
      title="Orders"
      description="Every order your inbox relays hold, with what your node credited for it."
      actions={
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          title="Every loaded order, whatever the filters"
          className="rounded-10 border-line bg-surface text-14 hover:bg-surface-2 flex items-center gap-6 border px-12 py-8 font-medium disabled:opacity-50"
        >
          <Icon name="download" className="size-16" />
          Download CSV
        </button>
      }
    >
      {snapshot.more && (
        <p id="csv-partial" className="text-13 text-text-2 -mt-8">
          The list and the CSV cover the loaded orders only: load more history for older ones.
        </p>
      )}
      <OrderFilters
        total={rows.length}
        counts={stateCounts(rows)}
        state={state}
        query={query}
        onState={setState}
        onQuery={setQuery}
      />
      <div className="rounded-16 border-line bg-surface overflow-hidden border">
        <div className="overflow-x-auto">
          <table className="text-13 w-full min-w-880 border-collapse text-left">
            <thead className="bg-surface-2/60 text-12 text-text-2">
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} className="px-16 py-10 font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
                <th className="w-44">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody id="orders">
              {shown.map((row) => (
                <OrderRowView key={row.key} row={row} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <EmptyState icon="receipt" title="No orders found.">
            Orders show up here once buyers order from your store. Many relays keep private messages
            for only about two days.
          </EmptyState>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <EmptyState icon="search" title="No order matches these filters." />
        )}
      </div>
      <div className="text-13 text-text-2 flex flex-wrap items-center justify-between gap-12">
        <span>
          {filtered
            ? `${shown.length} of ${countText(rows.length, 'loaded order')}`
            : countText(rows.length, 'loaded order')}
        </span>
        {snapshot.more && (
          <button
            type="button"
            onClick={onMore}
            disabled={busy}
            className="rounded-10 border-line bg-surface text-14 text-text hover:bg-surface-2 border px-14 py-8 font-medium disabled:opacity-50"
          >
            Load more history
          </button>
        )}
      </div>
    </Section>
  );
}
