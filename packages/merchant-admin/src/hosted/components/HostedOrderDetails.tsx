import { TxLink } from '../../components/TxLink';
import { coinAmountText, txExplorer } from '../lib/amounts';
import { coinLabel } from '../lib/coins';
import { type OrderEntry, handText, utcText, webhookText } from '../lib/orders';

interface Props {
  entry: OrderEntry;
}

/** Everything the store knows of one order, in full. */
export function HostedOrderDetails({ entry }: Props) {
  const { order, hand } = entry;
  const paid = order?.paid;
  let title = 'not in the ledger any more (answered by hand)';
  if (order !== undefined) {
    title = order.productTitle ?? 'deleted product';
  }
  const paidExplorer = paid === undefined ? undefined : txExplorer(paid.caip19, paid.signature);
  const handExplorer =
    hand?.tx === undefined || hand.caip19 === undefined
      ? undefined
      : txExplorer(hand.caip19, hand.tx);
  let handAmount: string | undefined;
  if (hand?.amount !== undefined) {
    handAmount =
      hand.caip19 === undefined
        ? `${hand.amount} subunits`
        : coinAmountText(hand.amount, hand.caip19);
  }

  return (
    <dl className="text-13 grid grid-cols-[auto_1fr] gap-x-16 gap-y-6">
      <dt className="text-text-2">Order ID</dt>
      <dd className="font-mono break-all">{entry.orderId}</dd>
      <dt className="text-text-2">Buyer</dt>
      <dd className="font-mono break-all">{entry.buyerPubkey}</dd>
      <dt className="text-text-2">Product (current title)</dt>
      <dd data-field="title">{title}</dd>
      {order === undefined ? null : (
        <>
          <dt className="text-text-2">Product address</dt>
          <dd className="font-mono break-all">{order.product}</dd>
          <dt className="text-text-2">Ordered at</dt>
          <dd>{utcText(order.createdAt)}</dd>
          <dt className="text-text-2">Email</dt>
          <dd className="break-all">{order.email ?? 'none'}</dd>
          <dt className="text-text-2">Customer ref</dt>
          <dd className="break-all">{order.customerRef ?? 'none'}</dd>
        </>
      )}
      {paid === undefined ? null : (
        <>
          <dt className="text-text-2">Paid</dt>
          <dd data-field="paid">
            {coinAmountText(paid.amount, paid.caip19)} ({coinLabel(paid.caip19) ?? paid.caip19})
          </dd>
          <dt className="text-text-2">Protocol fee</dt>
          <dd data-field="fee">{coinAmountText(paid.fee, paid.caip19)}</dd>
          <dt className="text-text-2">Payment</dt>
          <dd>
            <TxLink
              tx={paid.signature}
              full
              {...(paidExplorer === undefined ? {} : { explorer: paidExplorer })}
            />
          </dd>
        </>
      )}
      {order?.deliveredAt === undefined ? null : (
        <>
          <dt className="text-text-2">Delivered at</dt>
          <dd data-field="delivered">{utcText(order.deliveredAt)}</dd>
        </>
      )}
      {order?.webhook === undefined ? null : (
        <>
          <dt className="text-text-2">Webhook</dt>
          <dd data-field="webhook">{webhookText(order.webhook)}</dd>
        </>
      )}
      {order === undefined || order.reportedTxs.length === 0 ? null : (
        <>
          <dt className="text-text-2">Reported by the buyer</dt>
          <dd className="flex flex-col gap-2">
            {order.reportedTxs.map((tx) => (
              <TxLink key={tx} tx={tx} full />
            ))}
          </dd>
        </>
      )}
      {entry.unresolved.length === 0 ? null : (
        <>
          <dt className="text-text-2">Unresolved payment</dt>
          <dd className="flex flex-col gap-2">
            {entry.unresolved.map((payment) => (
              <TxLink key={payment.tx} tx={payment.tx} full />
            ))}
          </dd>
        </>
      )}
      {hand === undefined ? null : (
        <>
          <dt className="text-text-2">Answer</dt>
          <dd data-field="hand">
            {handText(hand)}
            {handAmount === undefined ? null : `: ${handAmount}`}
          </dd>
          {hand.tx === undefined ? null : (
            <>
              <dt className="text-text-2">Refund</dt>
              <dd>
                <TxLink
                  tx={hand.tx}
                  full
                  {...(handExplorer === undefined ? {} : { explorer: handExplorer })}
                />
              </dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}
