/**
 * The hosted orders as CSV: one line per entry shown, full values, amounts in
 * whole coin units. Every cell goes through the formula-safe `csvCell`.
 */
import { csvCell } from '../../lib/csv-cell';
import { coinAmountText } from './amounts';
import { ORDER_STATE_LABELS, type OrderEntry, handText, utcText, webhookText } from './orders';

export const HOSTED_CSV_COLUMNS = [
  'time_utc',
  'order_id',
  'buyer_pubkey',
  'product',
  'current_title',
  'email',
  'ref',
  'state',
  'paid',
  'paid_fee',
  'paid_asset',
  'paid_tx',
  'delivered_at_utc',
  'webhook',
  'reported_txs',
  'unresolved_txs',
  'hand_answer',
  'hand_refund',
  'hand_refund_asset',
  'hand_refund_tx',
] as const;

function handRefund(entry: OrderEntry): string {
  const amount = entry.hand?.amount;
  if (amount === undefined) {
    return '';
  }
  const caip19 = entry.hand?.caip19;
  return caip19 === undefined ? `${amount} subunits` : coinAmountText(amount, caip19);
}

function entryCells(entry: OrderEntry): string[] {
  const { order, hand } = entry;
  const paid = order?.paid;
  return [
    order === undefined ? '' : utcText(order.createdAt),
    entry.orderId,
    entry.buyerPubkey,
    order?.product ?? '',
    order?.productTitle ?? '',
    order?.email ?? '',
    order?.customerRef ?? '',
    ORDER_STATE_LABELS[entry.state],
    paid === undefined ? '' : coinAmountText(paid.amount, paid.caip19),
    paid === undefined ? '' : coinAmountText(paid.fee, paid.caip19),
    paid?.caip19 ?? '',
    paid?.signature ?? '',
    order?.deliveredAt === undefined ? '' : utcText(order.deliveredAt),
    order?.webhook === undefined ? '' : webhookText(order.webhook),
    (order?.reportedTxs ?? []).join('; '),
    entry.unresolved.map((payment) => payment.tx).join('; '),
    entry.hand === undefined ? '' : handText(entry.hand),
    handRefund(entry),
    hand?.caip19 ?? '',
    hand?.tx ?? '',
  ];
}

/** The CSV text of `entries`: a UTF-8 BOM (so Excel reads non-ASCII text right) and CRLF line ends. */
export function hostedOrdersCsv(entries: readonly OrderEntry[]): string {
  const lines = [HOSTED_CSV_COLUMNS, ...entries.map(entryCells)].map((cells) =>
    cells.map(csvCell).join(','),
  );
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** `paycore-orders-<first 8 of the store pubkey>-<YYYY-MM-DD>.csv`. */
export function hostedCsvFileName(storePubkey: string, now: Date): string {
  return `paycore-orders-${storePubkey.slice(0, 8)}-${now.toISOString().slice(0, 10)}.csv`;
}
