import {
  CLAIM_LABELS,
  type OrderRow,
  STATE_LABELS,
  amountText,
  dateText,
  short,
} from '../lib/core';
import { TxLink } from './TxLink';

interface Props {
  row: OrderRow;
}

const STATE_CLASSES: Record<OrderRow['state'], string> = {
  ordered: 'text-text-2',
  payment_reported: 'text-warn',
  delivered: 'text-green',
  released: 'text-text-2',
  refunded: 'text-text-2',
};

/** One order. Everything a buyer or a relay wrote is React text, never markup. */
export function OrderRowView({ row }: Props) {
  const notes = [
    ...(row.orderNotLoaded ? ['order not loaded'] : []),
    ...(row.unlistedMedium ? ['receipt in a medium the store no longer lists'] : []),
  ];
  const settled = [...row.credits, ...row.refunds];
  return (
    <tr className="border-line border-t align-top">
      <td className="px-12 py-10 whitespace-nowrap">{dateText(row.createdAt)}</td>
      <td className="px-12 py-10 font-mono">
        <div className="max-w-200 break-all">{row.orderId}</div>
        {row.conflict && <div className="text-warn">conflict: different orders under this id</div>}
      </td>
      <td className="px-12 py-10">{row.product ?? ''}</td>
      <td className="px-12 py-10">
        {row.order !== undefined && (
          <>
            <div>{`${row.order.total.amount} ${row.order.total.currency}`}</div>
            {row.claimCheck !== undefined && (
              <div className={row.claimCheck === 'differs' ? 'text-warn' : 'text-text-2'}>
                {CLAIM_LABELS[row.claimCheck]}
              </div>
            )}
          </>
        )}
      </td>
      <td className="px-12 py-10 break-all">{row.order?.email ?? ''}</td>
      <td className="px-12 py-10 font-mono break-all">{row.order?.customerRef ?? ''}</td>
      <td className="px-12 py-10">
        <div className={STATE_CLASSES[row.state]}>{STATE_LABELS[row.state]}</div>
        {notes.map((note) => (
          <div key={note} className="text-text-2">
            {note}
          </div>
        ))}
      </td>
      <td className="px-12 py-10 whitespace-nowrap">
        {row.credits.map((credit) => (
          <div key={`${credit.medium}|${credit.tx}`}>{amountText(credit, credit.medium)}</div>
        ))}
        {row.refunds.map((refund) => (
          <div key={refund.tx} className="text-text-2">
            {`refund ${amountText(refund)}`}
          </div>
        ))}
      </td>
      <td className="px-12 py-10">
        {[
          ...row.credits.map((credit) => ({
            key: `credit:${credit.medium}|${credit.tx}`,
            amount: credit,
          })),
          ...row.refunds.map((refund) => ({ key: `refund:${refund.tx}`, amount: refund })),
        ].map(({ key, amount }) => (
          <div key={key}>
            <TxLink tx={amount.tx} explorer={amount.explorer} />
          </div>
        ))}
        {settled.length === 0 &&
          row.reported.map((reported) => (
            <div key={`${reported.medium}|${reported.tx}`}>
              <TxLink tx={reported.tx} />
            </div>
          ))}
      </td>
      <td className="px-12 py-10 font-mono" title={row.buyerPubkey}>
        {short(row.buyerPubkey)}
      </td>
    </tr>
  );
}
