import { type ReactNode, useState } from 'react';
import { countText } from '../lib/count';
import type { CsvAction } from '../lib/csv';
import { type ShownRow, type StateFilter, filterRows, stateCounts } from '../lib/orders';
import { CREDITOR, type Source } from '../lib/source';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { OrderFilters } from './OrderFilters';
import { OrderRowView } from './OrderRowView';
import { Section } from './Section';

interface Props {
  rows: readonly ShownRow[];
  busy: boolean;
  /** Older history exists: the list says it covers the loaded orders, and loads more. */
  onMore?: () => void;
  csv: CsvAction;
  source?: Source;
  /** More buttons beside the CSV (the cloud's "Read the orders again"). */
  tools?: ReactNode;
  /** Above the list (the orders waiting for the owner), and below it. */
  before?: ReactNode;
  after?: ReactNode;
  /** The owner's commands on one order, shown in its details. */
  actionsFor?: (row: ShownRow) => ReactNode;
}

const DESCRIPTIONS: Readonly<Record<Source, string>> = {
  'self-hosted': 'Every order your inbox relays hold, with what your node credited for it.',
  cloud: 'Every order of your store, with what your store credited for it.',
};

export function OrdersSection({
  rows,
  busy,
  onMore,
  csv,
  source = 'self-hosted',
  tools,
  before,
  after,
  actionsFor,
}: Props) {
  const columns = [
    'Date',
    'Order',
    'Customer',
    'Total',
    'State',
    `Credited by ${CREDITOR[source]}`,
  ];
  const [state, setState] = useState<StateFilter>('all');
  const [query, setQuery] = useState('');
  const shown = filterRows(rows, state, query);
  const filtered = shown.length !== rows.length;
  return (
    <Section
      title="Orders"
      heading="h1"
      description={DESCRIPTIONS[source]}
      actions={
        <div className="flex flex-wrap gap-8">
          {tools}
          <button
            type="button"
            onClick={csv.run}
            disabled={csv.empty === true || csv.busy === true}
            title={csv.title}
            className="rounded-10 border-line bg-surface text-14 hover:bg-surface-2 flex items-center gap-6 border px-12 py-8 font-medium disabled:opacity-50"
          >
            <Icon name="download" className="size-16" />
            Download CSV
          </button>
        </div>
      }
    >
      {before}
      {onMore !== undefined && (
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
                {columns.map((column) => (
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
                <OrderRowView key={row.key} row={row} source={source} actions={actionsFor?.(row)} />
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
        {onMore !== undefined && (
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
      {after}
    </Section>
  );
}
