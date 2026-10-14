import { type OrderRow, dateText } from '../lib/core';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { StatusPill } from './StatusPill';

interface Props {
  rows: readonly OrderRow[];
  onViewAll: () => void;
}

const RECENT = 5;

export function RecentOrders({ rows, onViewAll }: Props) {
  const recent = [...rows]
    .sort((first, second) => second.createdAt - first.createdAt)
    .slice(0, RECENT);
  return (
    <div className="rounded-16 border-line bg-surface flex flex-col border">
      <div className="border-line flex items-center justify-between gap-12 border-b px-16 py-12">
        <h3 className="text-15 font-semibold">Recent orders</h3>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-13 text-text-2 hover:text-text flex items-center gap-4 font-medium"
          >
            View all
            <Icon name="arrow" className="size-14" />
          </button>
        )}
      </div>
      {recent.length === 0 ? (
        <EmptyState icon="receipt" title="No orders yet">
          Orders show up here once buyers order from your store.
        </EmptyState>
      ) : (
        <ul className="divide-line divide-y">
          {recent.map((row) => (
            <li key={row.key} className="flex items-center gap-12 px-16 py-12">
              <div className="min-w-0 flex-1">
                <p className="text-14 truncate font-medium">{row.product ?? 'Unknown product'}</p>
                <p className="text-12 text-text-3 truncate">
                  {[dateText(row.createdAt), row.order?.email].filter(Boolean).join(' · ')}
                </p>
              </div>
              {row.order !== undefined && (
                <span className="text-14 font-medium whitespace-nowrap">
                  {`${row.order.total.amount} ${row.order.total.currency}`}
                </span>
              )}
              <StatusPill state={row.state} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
