import type { ReactNode } from 'react';
import { CLAIM_LABELS, STATE_LABELS, amountText, dateText } from '../lib/core';
import { type ShownRow, customerRefOf, emailOf, feeText, rowNotes } from '../lib/orders';
import type { Source } from '../lib/source';
import { CopyButton } from './CopyButton';
import { TxLink } from './TxLink';

interface Props {
  row: ShownRow;
  /** A cloud order has no buyer's order to read a claimed total from: none is shown. */
  source?: Source;
  /** What the owner can do with this order (a cloud store's commands), under its details. */
  actions?: ReactNode;
}

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <dt className="text-12 text-text-3 font-medium">{label}</dt>
      <dd className="text-13 min-w-0">{children}</dd>
    </div>
  );
}

/** Everything the admin knows of one order, in full. */
export function OrderDetails({ row, source = 'self-hosted', actions }: Props) {
  const notes = rowNotes(row);
  const settled = [...row.credits, ...row.refunds];
  return (
    <div className="flex flex-col gap-12">
      <dl className="rounded-12 border-line bg-surface grid gap-16 border p-16 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Order id">
          <span className="flex items-start gap-4">
            <span className="font-mono break-all">{row.orderId}</span>
            <CopyButton text={row.orderId} label="Copy order id" />
          </span>
        </Field>
        <Field label="Buyer key">
          <span className="flex items-start gap-4">
            <span className="font-mono break-all">{row.buyerPubkey}</span>
            <CopyButton text={row.buyerPubkey} label="Copy buyer key" />
          </span>
        </Field>
        <Field label="Ordered">{dateText(row.createdAt)}</Field>
        <Field label="Product">{row.product ?? 'Unknown product'}</Field>
        <Field label="Email">{emailOf(row) ?? 'none'}</Field>
        <Field label="Reference">
          <span className="font-mono break-all">{customerRefOf(row) ?? 'none'}</span>
        </Field>
        {source === 'cloud' ? null : (
          <Field label="Buyer's claimed total">
            {row.order === undefined
              ? 'order not loaded'
              : `${row.order.total.amount} ${row.order.total.currency}${row.claimCheck === undefined ? '' : `, ${CLAIM_LABELS[row.claimCheck]}`}`}
          </Field>
        )}
        <Field label="State">
          {[
            STATE_LABELS[row.state],
            // A note the full label already says is not said twice.
            ...notes.filter((note) => !STATE_LABELS[row.state].includes(note)),
          ].join('; ')}
        </Field>
        <Field label="Transactions">
          <span className="flex flex-col gap-4">
            {row.credits.map((credit) => (
              <span key={`${credit.medium}|${credit.tx}`} className="flex flex-col">
                <span>{`credited ${amountText(credit, credit.medium)}`}</span>
                {feeText(credit) !== undefined && (
                  <span className="text-text-2">{`of which elisym fee ${feeText(credit)}`}</span>
                )}
                <TxLink tx={credit.tx} explorer={credit.explorer} full />
              </span>
            ))}
            {row.refunds.map((refund) => (
              <span key={refund.tx} className="flex flex-col">
                <span>{`refund ${amountText(refund)}`}</span>
                <TxLink tx={refund.tx} explorer={refund.explorer} full />
              </span>
            ))}
            {settled.length === 0 &&
              row.reported.map((reported) => (
                <span key={`${reported.medium}|${reported.tx}`} className="flex flex-col">
                  <span>{`reported on ${reported.medium}`}</span>
                  <TxLink tx={reported.tx} full />
                </span>
              ))}
            {settled.length === 0 && row.reported.length === 0 && 'none'}
          </span>
        </Field>
      </dl>
      {actions}
    </div>
  );
}
