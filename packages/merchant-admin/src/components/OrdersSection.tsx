import type { Snapshot } from '../lib/core';
import { csvFileName, ordersCsv } from '../lib/csv';
import { downloadText } from '../lib/download';
import { OrderRowView } from './OrderRowView';
import { Section } from './Section';

interface Props {
  snapshot: Snapshot;
  busy: boolean;
  onMore: () => void;
}

const COLUMNS = [
  'Time',
  'Order',
  'Product',
  "Buyer's claimed total",
  'Email',
  'Ref',
  'State',
  'Credited by your node',
  'Transaction',
  'Buyer',
];

export function OrdersSection({ snapshot, busy, onMore }: Props) {
  const { rows } = snapshot.history;
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
      actions={
        <div className="flex flex-wrap items-center gap-8">
          {snapshot.more && (
            <span id="csv-partial" className="text-13 text-text-2">
              Covers the loaded orders only: load more history first.
            </span>
          )}
          <button
            type="button"
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="rounded-8 border-line text-14 hover:bg-surface-2 border px-12 py-6 disabled:opacity-50"
          >
            Download CSV
          </button>
        </div>
      }
    >
      <div className="rounded-12 border-line bg-surface overflow-x-auto border">
        <table className="text-13 w-full min-w-960 border-collapse text-left">
          <thead className="bg-surface-2 text-text-2">
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} className="px-12 py-8 font-medium whitespace-nowrap">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody id="orders">
            {rows.map((row) => (
              <OrderRowView key={row.key} row={row} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="text-14 text-text-2 p-16">No orders found.</p>}
      </div>
      {snapshot.more && (
        <p className="text-14 text-text-2 flex flex-wrap items-center gap-8">
          More history not loaded.
          <button
            type="button"
            onClick={onMore}
            disabled={busy}
            className="rounded-8 border-line text-text hover:bg-surface-2 border px-12 py-6 disabled:opacity-50"
          >
            Load more history
          </button>
        </p>
      )}
    </Section>
  );
}
