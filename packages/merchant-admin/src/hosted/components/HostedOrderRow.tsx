import { useState } from 'react';
import { ORDER_STATE_LABELS, type OrderEntry, utcText } from '../lib/orders';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { HandAnswerForm } from './HandAnswerForm';
import { HostedOrderDetails } from './HostedOrderDetails';

interface Props {
  session: StoreSession;
  view: StoreView;
  entry: OrderEntry;
  onAnswered: () => void;
}

/** One order: its summary, and on demand its details and, for an unresolved payment, the hand answer. */
export function HostedOrderRow({ session, view, entry, onAnswered }: Props) {
  const [open, setOpen] = useState(false);
  // Once sent, the form stays to say how it ended, though the order is answered now.
  const [sent, setSent] = useState(false);
  const { order } = entry;
  const answerable = sent || (entry.unresolved.length > 0 && entry.hand === undefined);
  return (
    <li className="border-line flex flex-col gap-12 border-b py-12" data-order={entry.key}>
      <button
        type="button"
        className="text-14 flex flex-wrap items-baseline gap-x-12 gap-y-4 text-left"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="text-text-2 font-mono">
          {order === undefined ? 'closed' : utcText(order.createdAt).slice(0, 16)}
        </span>
        <span className="font-mono break-all">{entry.orderId}</span>
        <span data-field="state" className="font-semibold">
          {ORDER_STATE_LABELS[entry.state]}
        </span>
        {order === undefined ? null : (
          <span className="text-text-2">{order.productTitle ?? 'deleted product'}</span>
        )}
        {order?.email === undefined ? null : (
          <span className="text-text-2 break-all">{order.email}</span>
        )}
      </button>
      {open ? (
        <div className="flex flex-col gap-16 pl-12">
          <HostedOrderDetails entry={entry} />
          {answerable ? (
            <HandAnswerForm
              session={session}
              view={view}
              orderKey={entry.key}
              onAnswered={() => {
                setSent(true);
                onAnswered();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
