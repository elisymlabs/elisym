import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadText } from '../../lib/download';
import { errorMessage } from '../lib/errors';
import {
  ORDER_STATES,
  ORDER_STATE_LABELS,
  type OrderFilter,
  orderEntries,
  visibleEntries,
} from '../lib/orders';
import { hostedCsvFileName, hostedOrdersCsv } from '../lib/orders-csv';
import type { StoreSession } from '../lib/store-session';
import type { OrdersView, StoreView } from '../lib/types';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { HostedOrderRow } from './HostedOrderRow';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  view: StoreView;
  onChanged: () => void;
}

export const ORDERS_KEPT = 'The page shows your orders as they were last read.';
export const NEEDS_ANSWER = (count: number) =>
  `${count} order${count === 1 ? ' has' : 's have'} a payment your store could not match on its own. Open ${count === 1 ? 'it' : 'each'} to answer by hand.`;

const FILTERS: readonly { value: OrderFilter; label: string }[] = [
  { value: 'all', label: 'All orders' },
  ...ORDER_STATES.map((state) => ({ value: state, label: ORDER_STATE_LABELS[state] })),
];

/**
 * The store's orders, newest first (A8): filter by state, search the email,
 * customer ref or order id, open one for its details or a hand answer, and
 * export what is shown as CSV.
 */
export function OrdersTab({ session, view, onChanged }: Props) {
  const [orders, setOrders] = useState<OrdersView | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [query, setQuery] = useState('');
  // Answered here: still shown whatever the filter, so the answer's outcome stays in sight.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const reads = useRef(0);
  const { api } = session;

  /** Read the orders again; only the newest read's answer counts. */
  const load = useCallback(() => {
    reads.current += 1;
    const read = reads.current;
    api.orders().then(
      (next) => {
        if (read === reads.current) {
          setOrders(next);
          setProblem(undefined);
        }
      },
      (error: unknown) => {
        if (read === reads.current) {
          setProblem(errorMessage(error));
        }
      },
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  let warning: string | undefined;
  if (problem !== undefined) {
    warning = orders === undefined ? problem : `${problem} ${ORDERS_KEPT}`;
  }
  if (orders === undefined) {
    return warning === undefined ? (
      <p className="text-14 text-text-2" role="status">
        Reading your orders...
      </p>
    ) : (
      <div className="flex flex-col gap-12">
        <Notice tone="error">{warning}</Notice>
        <div>
          <button type="button" className={BUTTON_SECONDARY} onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const entries = orderEntries(orders);
  const matching = new Set(visibleEntries(entries, filter, query));
  const shown = entries.filter((entry) => matching.has(entry) || answered.has(entry.key));
  const unanswered = entries.filter(
    (entry) => entry.unresolved.length > 0 && entry.hand === undefined,
  ).length;

  const exportCsv = () =>
    downloadText(
      document,
      hostedOrdersCsv(shown),
      hostedCsvFileName(view.storePubkey, new Date()),
      'text/csv;charset=utf-8',
    );

  return (
    <div className="flex flex-col gap-16">
      {warning === undefined ? null : <Notice tone="warn">{warning}</Notice>}
      {unanswered === 0 ? null : <Notice tone="warn">{NEEDS_ANSWER(unanswered)}</Notice>}
      <div className="flex flex-wrap items-end gap-12">
        <label className="text-14 flex flex-col gap-4">
          Show
          <select
            id="orders-filter"
            className={INPUT}
            value={filter}
            onChange={(event) => {
              const next = FILTERS.find((option) => option.value === event.target.value);
              setFilter(next?.value ?? 'all');
            }}
          >
            {FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-14 flex min-w-0 flex-1 flex-col gap-4">
          Search email, customer ref or order ID
          <input
            id="orders-search"
            className={INPUT}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={shown.length === 0}
          onClick={exportCsv}
        >
          Export CSV
        </button>
        <button type="button" className={BUTTON_SECONDARY} onClick={load}>
          Refresh
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="text-14 text-text-2" id="orders-empty">
          {entries.length === 0 ? 'No orders yet.' : 'No order matches.'}
        </p>
      ) : (
        <ul className="flex flex-col" id="orders-list">
          {shown.map((entry) => (
            <HostedOrderRow
              key={entry.key}
              session={session}
              view={view}
              entry={entry}
              onAnswered={() => {
                setAnswered((current) => new Set([...current, entry.key]));
                load();
                onChanged();
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
