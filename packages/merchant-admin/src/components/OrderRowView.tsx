import { useId, useState } from 'react';
import { CLAIM_LABELS, type OrderRow, amountText, dateText, short } from '../lib/core';
import { feeText, rowNotes } from '../lib/orders';
import { Icon } from './Icon';
import { OrderDetails } from './OrderDetails';
import { StatusPill } from './StatusPill';
import { TxLink } from './TxLink';

interface Props {
  row: OrderRow;
}

/** One order, and its details on demand. Everything a buyer or a relay wrote is React text, never markup. */
export function OrderRowView({ row }: Props) {
  const [open, setOpen] = useState(false);
  const settled = [...row.credits, ...row.refunds];
  const detailsId = useId();
  return (
    <>
      <tr
        onClick={(event) => {
          // A link, a button, a text selection or the second click of a double-click
          // (selecting a word) is not a request to toggle the row.
          const inControl =
            event.target instanceof Element && event.target.closest('a, button') !== null;
          const selecting = (window.getSelection()?.toString() ?? '') !== '';
          if (inControl || selecting || event.detail > 1) {
            return;
          }
          setOpen((previous) => !previous);
        }}
        className={`border-line hover:bg-surface-2/40 cursor-pointer border-t align-top ${open ? 'bg-surface-2/50' : ''}`}
      >
        <td className="text-text-2 px-16 py-12 whitespace-nowrap">{dateText(row.createdAt)}</td>
        <td className="px-16 py-12">
          <div className="max-w-240 truncate font-medium" title={row.product}>
            {row.product ?? 'Unknown product'}
          </div>
          <div className="text-12 text-text-3 font-mono" title={row.orderId}>
            {short(row.orderId)}
          </div>
          {row.conflict && (
            <div className="text-12 text-warn">conflict: different orders under this id</div>
          )}
        </td>
        <td className="px-16 py-12">
          {row.order?.email !== undefined && (
            <div className="max-w-220 truncate" title={row.order.email}>
              {row.order.email}
            </div>
          )}
          {row.order?.customerRef !== undefined && (
            <div className="text-12 text-text-2 max-w-220 truncate" title={row.order.customerRef}>
              {`ref ${row.order.customerRef}`}
            </div>
          )}
          <div className="text-12 text-text-3 font-mono" title={row.buyerPubkey}>
            {short(row.buyerPubkey)}
          </div>
        </td>
        <td className="px-16 py-12 whitespace-nowrap">
          {row.order !== undefined && (
            <>
              <div className="font-medium">{`${row.order.total.amount} ${row.order.total.currency}`}</div>
              {row.claimCheck !== undefined && (
                <div
                  className={`text-12 ${row.claimCheck === 'differs' ? 'text-warn' : 'text-text-3'}`}
                >
                  {CLAIM_LABELS[row.claimCheck]}
                </div>
              )}
            </>
          )}
        </td>
        <td className="px-16 py-12">
          <StatusPill state={row.state} />
          {rowNotes(row).map((note) => (
            <div key={note} className="text-12 text-text-3 mt-4">
              {note}
            </div>
          ))}
        </td>
        <td className="px-16 py-12">
          {row.credits.map((credit) => (
            <div key={`${credit.medium}|${credit.tx}`} className="flex flex-col">
              <span className="font-medium whitespace-nowrap">
                {amountText(credit, credit.medium)}
              </span>
              {feeText(credit) !== undefined && (
                <span className="text-12 text-text-3 whitespace-nowrap">{`elisym fee ${feeText(credit)}`}</span>
              )}
              <span className="text-12">
                <TxLink tx={credit.tx} explorer={credit.explorer} />
              </span>
            </div>
          ))}
          {row.refunds.map((refund) => (
            <div key={refund.tx} className="text-text-2 flex flex-col">
              <span className="whitespace-nowrap">{`refund ${amountText(refund)}`}</span>
              <span className="text-12">
                <TxLink tx={refund.tx} explorer={refund.explorer} />
              </span>
            </div>
          ))}
          {settled.length === 0 &&
            row.reported.map((reported) => (
              <div key={`${reported.medium}|${reported.tx}`} className="text-12 text-text-2">
                <TxLink tx={reported.tx} />
              </div>
            ))}
        </td>
        <td className="py-12 pr-12 text-right">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            aria-label={open ? 'Hide order details' : 'Show order details'}
            onClick={() => setOpen((previous) => !previous)}
            className="rounded-8 text-text-3 hover:bg-surface-2 hover:text-text inline-grid size-28 place-items-center"
          >
            <Icon
              name="chevron"
              className={`size-16 transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>
        </td>
      </tr>
      {open && (
        <tr id={detailsId} className="bg-surface-2/50">
          <td colSpan={7} className="px-16 pb-16">
            <OrderDetails row={row} />
          </td>
        </tr>
      )}
    </>
  );
}
