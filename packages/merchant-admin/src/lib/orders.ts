import { type Credit, type OrderRow, type OrderState, amountText } from './core';

/** The states in the order the filters list them. */
export const STATE_ORDER: readonly OrderState[] = [
  'delivered',
  'payment_reported',
  'ordered',
  'refunded',
  'released',
];

/** A state's short name, for a badge or a filter: the full wording is `STATE_LABELS`. */
export const STATE_SHORT: Readonly<Record<OrderState, string>> = {
  ordered: 'Ordered',
  payment_reported: 'Payment reported',
  delivered: 'Completed',
  released: 'Released by hand',
  refunded: 'Refunded',
};

export const STATE_TONE: Readonly<Record<OrderState, string>> = {
  ordered: 'bg-surface-2 text-text-2',
  payment_reported: 'bg-warn-bg text-warn',
  delivered: 'bg-green-bg text-green',
  released: 'bg-blue-bg text-blue',
  refunded: 'bg-surface-2 text-text-2',
};

export type StateFilter = OrderState | 'all';

/** How many loaded orders are in each state. */
export function stateCounts(rows: readonly OrderRow[]): Record<OrderState, number> {
  const counts: Record<OrderState, number> = {
    ordered: 0,
    payment_reported: 0,
    delivered: 0,
    released: 0,
    refunded: 0,
  };
  for (const row of rows) {
    counts[row.state] += 1;
  }
  return counts;
}

/** The row's searchable text: ids, product, email, reference and buyer. */
function searchText(row: OrderRow): string {
  return [row.orderId, row.product, row.order?.email, row.order?.customerRef, row.buyerPubkey]
    .filter((part): part is string => part !== undefined)
    .join('\n')
    .toLowerCase();
}

export function filterRows(
  rows: readonly OrderRow[],
  state: StateFilter,
  query: string,
): OrderRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (state === 'all' || row.state === state) &&
      (needle === '' || searchText(row).includes(needle)),
  );
}

/** The elisym protocol fee a credit carried, as text; undefined when it carried none. */
export function feeText(credit: Credit): string | undefined {
  return credit.fee === '0'
    ? undefined
    : amountText({ ...credit, amount: credit.fee }, credit.medium);
}

/** The notes on a row's state, besides the state itself. */
export function rowNotes(row: OrderRow): string[] {
  return [
    ...(row.state === 'payment_reported' ? ['not confirmed by your node'] : []),
    ...(row.orderNotLoaded ? ['order not loaded'] : []),
    ...(row.unlistedMedium ? ['receipt in a medium the store no longer lists'] : []),
  ];
}
