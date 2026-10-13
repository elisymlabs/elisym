/**
 * The orders as CSV: one line per order, full values, amounts as decimal
 * strings. Every cell is quoted, and a cell a spreadsheet would read as a
 * formula is prefixed with `'` (buyers write the email and the reference).
 */
import { CLAIM_LABELS, type NodeAmount, type OrderRow, STATE_LABELS, wholeUnits } from './core';

export const CSV_COLUMNS = [
  'time_utc',
  'order_id',
  'buyer_pubkey',
  'product',
  'claimed_total',
  'claim_check',
  'email',
  'ref',
  'state',
  'credited',
  'credited_asset',
  'refunded',
  'refunded_asset',
  'transactions',
  'notes',
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, quoted, safe to open in a spreadsheet. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function amountOf(amount: NodeAmount): string {
  return amount.asset === undefined
    ? `${amount.amount} subunits`
    : wholeUnits(amount.amount, amount.asset);
}

function assetOf(amount: NodeAmount, unknown: string): string {
  return amount.asset === undefined ? unknown : amount.asset.id;
}

function rowCells(row: OrderRow): string[] {
  const settled = [...row.credits, ...row.refunds].map((amount) => amount.tx);
  const transactions = settled.length > 0 ? settled : row.reported.map((reported) => reported.tx);
  const notes = [
    ...(row.conflict ? ['conflict'] : []),
    ...(row.orderNotLoaded ? ['order not loaded'] : []),
    ...(row.unlistedMedium ? ['unlisted medium'] : []),
  ];
  const single = row.conflict || row.orderNotLoaded ? undefined : row.order;
  return [
    new Date(row.createdAt * 1000).toISOString(),
    row.orderId,
    row.buyerPubkey,
    row.product ?? '',
    single === undefined ? '' : `${single.total.amount} ${single.total.currency}`,
    row.claimCheck === undefined ? '' : CLAIM_LABELS[row.claimCheck],
    row.order?.email ?? '',
    row.order?.customerRef ?? '',
    STATE_LABELS[row.state],
    row.credits.map(amountOf).join('; '),
    row.credits.map((credit) => assetOf(credit, `unknown (${credit.medium})`)).join('; '),
    row.refunds.map(amountOf).join('; '),
    row.refunds.map((refund) => assetOf(refund, 'unknown')).join('; '),
    transactions.join('; '),
    notes.join('; '),
  ];
}

/** The CSV text of `rows`: a UTF-8 BOM (so Excel reads non-ASCII text right) and CRLF line ends. */
export function ordersCsv(rows: readonly OrderRow[]): string {
  const lines = [CSV_COLUMNS, ...rows.map(rowCells)].map((cells) => cells.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** `elisym-orders-<first 8 of the store pubkey>-<YYYY-MM-DD>.csv`. */
export function csvFileName(storePubkey: string, now: Date): string {
  return `elisym-orders-${storePubkey.slice(0, 8)}-${now.toISOString().slice(0, 10)}.csv`;
}
