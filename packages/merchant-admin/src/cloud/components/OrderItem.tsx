import { Button } from '../../components/Button';
import { type OrderCommand, type OrderRead, shownAmount, txLink } from '../lib/orders';
import { shownTime } from '../lib/store-view';

interface Props {
  order: OrderRead;
  /** Asks one of the order's commands (it is confirmed before it is queued). */
  onAsk: (command: OrderCommand) => void;
  /** Whether a command is being asked already (one at a time). */
  busy: boolean;
}

const WEBHOOK_TEXT: Record<NonNullable<OrderRead['webhook']>['state'], string> = {
  pending: 'webhook pending',
  sent: 'webhook sent',
  failed: 'webhook failed',
};

/** One open or paid order: what was bought, its payment and delivery, and its webhook commands. */
export function OrderItem({ order, onAsk, busy }: Props) {
  const { payment, webhook } = order;
  const link = payment === null ? undefined : txLink(payment.signature, payment.asset);
  let status: string;
  if (payment === null) {
    status = 'Not paid';
  } else if (order.deliveredAt === null) {
    status = 'Paid, not delivered yet';
  } else {
    status = `Paid, delivered ${shownTime(order.deliveredAt)}`;
  }
  return (
    <li className="border-line flex flex-col gap-4 border-b py-12">
      <p className="text-14 font-medium">
        {order.product}{' '}
        <span className="text-text-3 font-normal">{shownTime(order.createdAt)}</span>
      </p>
      <p className="text-13 text-text-2 break-all">Order {order.key}</p>
      <p className="text-13">
        {status}
        {payment === null ? null : (
          <>
            {': '}
            {shownAmount(payment.amount, payment.asset)} paid
            {payment.fee === '0'
              ? null
              : ` (${shownAmount(payment.fee, payment.asset)} of it the protocol fee)`}
            {link === undefined ? (
              <span className="break-all"> in {payment.signature}</span>
            ) : (
              <>
                {' '}
                <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
                  transaction
                </a>
              </>
            )}
          </>
        )}
      </p>
      {order.email === null ? null : <p className="text-13 text-text-2">Email {order.email}</p>}
      {order.customerRef === null ? null : (
        <p className="text-13 text-text-2 break-all">Customer ref {order.customerRef}</p>
      )}
      {webhook === null ? null : (
        <p className="text-13 text-text-2">
          {WEBHOOK_TEXT[webhook.state]}
          {webhook.attempts === 0 ? null : `, ${webhook.attempts} attempts`}
          {webhook.lastStatus === null ? null : `, last answer HTTP ${webhook.lastStatus}`}
          {webhook.lastError === null ? null : `, ${webhook.lastError}`}
        </p>
      )}
      {payment === null ? null : (
        <div className="flex gap-8">
          {webhook === null || webhook.state === 'sent' ? (
            <Button
              disabled={busy}
              onClick={() => onAsk({ kind: 'webhook resend', key: order.key })}
              size="sm"
            >
              Send the webhook once more
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() => onAsk({ kind: 'webhook retry', key: order.key })}
              size="sm"
            >
              Retry the webhook now
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
