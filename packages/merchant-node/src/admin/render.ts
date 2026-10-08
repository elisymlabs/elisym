/**
 * Renders the history into the page. Everything a buyer or a relay wrote is set
 * with `textContent` only, and a link is made only from an `https:` explorer URL.
 */
import type { ClaimCheck, History, NodeAmount, OrderRow, OrderState } from './history';
import { wholeUnits } from './history';
import type { ProductLine } from './store';

const STATE_LABELS: Record<OrderState, string> = {
  ordered: 'ordered',
  payment_reported: 'payment reported (not confirmed by your node)',
  delivered: 'completed',
  released: 'released by hand',
  refunded: 'refunded',
};

const CLAIM_LABELS: Record<ClaimCheck, string> = {
  matches: 'matches the listing',
  differs: 'differs from the listing',
  not_checked: 'listing changed around this order (not checked)',
};

/** Characters kept at each end of a shortened key or transaction. */
const SHORT_EDGE = 8;

function short(value: string): string {
  return value.length <= SHORT_EDGE * 2 + 1
    ? value
    : `${value.slice(0, SHORT_EDGE)}...${value.slice(-SHORT_EDGE)}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const created = doc.createElement(tag);
  if (text !== undefined) {
    created.textContent = text;
  }
  if (className !== undefined) {
    created.className = className;
  }
  return created;
}

/** A transaction: a link to its explorer page when there is one, else its text. */
function txElement(doc: Document, tx: string, explorer: string | undefined): HTMLElement {
  if (explorer === undefined || !explorer.startsWith('https://')) {
    return element(doc, 'span', short(tx), 'mono');
  }
  const link = element(doc, 'a', short(tx), 'mono');
  link.href = explorer;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

/** An amount the node named: whole units of its asset, else raw subunits. */
export function amountText(amount: NodeAmount, medium?: string): string {
  if (amount.asset !== undefined) {
    return `${wholeUnits(amount.amount, amount.asset)} ${amount.asset.asset.symbol}`;
  }
  return medium === undefined
    ? `${amount.amount} subunits, asset unknown`
    : `${amount.amount} subunits (${medium}), asset unknown`;
}

function dateText(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function lines(doc: Document, cell: HTMLElement, texts: readonly string[], className?: string) {
  for (const text of texts) {
    cell.append(element(doc, 'div', text, className));
  }
}

function rowElement(doc: Document, row: OrderRow): HTMLTableRowElement {
  const tr = element(doc, 'tr');

  tr.append(element(doc, 'td', dateText(row.createdAt)));

  const orderCell = element(doc, 'td', undefined, 'mono');
  orderCell.append(element(doc, 'div', row.orderId));
  if (row.conflict) {
    orderCell.append(element(doc, 'div', 'conflict: different orders under this id', 'warn'));
  }
  tr.append(orderCell);

  tr.append(element(doc, 'td', row.product ?? ''));

  const claimCell = element(doc, 'td');
  if (row.order !== undefined) {
    claimCell.append(element(doc, 'div', `${row.order.total.amount} ${row.order.total.currency}`));
    if (row.claimCheck !== undefined) {
      claimCell.append(
        element(
          doc,
          'div',
          CLAIM_LABELS[row.claimCheck],
          row.claimCheck === 'differs' ? 'warn' : 'note',
        ),
      );
    }
  }
  tr.append(claimCell);

  tr.append(element(doc, 'td', row.order?.email ?? ''));
  tr.append(element(doc, 'td', row.order?.customerRef ?? '', 'mono'));

  const stateCell = element(doc, 'td');
  stateCell.append(element(doc, 'div', STATE_LABELS[row.state], `state state-${row.state}`));
  const notes: string[] = [];
  if (row.orderNotLoaded) {
    notes.push('order not loaded');
  }
  if (row.unlistedMedium) {
    notes.push('receipt in a medium the store no longer lists');
  }
  lines(doc, stateCell, notes, 'note');
  tr.append(stateCell);

  const creditedCell = element(doc, 'td');
  lines(
    doc,
    creditedCell,
    row.credits.map((credit) => amountText(credit, credit.medium)),
  );
  lines(
    doc,
    creditedCell,
    row.credits
      .filter((credit) => credit.fee !== '0')
      .map((credit) => `of which elisym fee ${amountText({ ...credit, amount: credit.fee })}`),
    'note',
  );
  lines(
    doc,
    creditedCell,
    row.refunds.map((refund) => `refund ${amountText(refund)}`),
    'note',
  );
  tr.append(creditedCell);

  const txCell = element(doc, 'td');
  for (const amount of [...row.credits, ...row.refunds]) {
    const line = element(doc, 'div');
    line.append(txElement(doc, amount.tx, amount.explorer));
    txCell.append(line);
  }
  if (row.credits.length === 0 && row.refunds.length === 0) {
    for (const reported of row.reported) {
      const line = element(doc, 'div');
      line.append(txElement(doc, reported.tx, undefined));
      txCell.append(line);
    }
  }
  tr.append(txCell);

  tr.append(element(doc, 'td', short(row.buyerPubkey), 'mono'));
  return tr;
}

/** Fill the table body and the totals list from `history`. */
export function renderHistory(
  doc: Document,
  history: History,
  targets: { body: HTMLElement; totals: HTMLElement; empty: HTMLElement },
): void {
  targets.body.replaceChildren(...history.rows.map((row) => rowElement(doc, row)));
  targets.empty.hidden = history.rows.length > 0;

  const totals: HTMLElement[] = history.totals.perAsset.map((total) =>
    element(doc, 'li', `${total.amount} ${total.asset.asset.symbol} (${total.asset.id})`),
  );
  for (const raw of history.totals.unknownAsset) {
    totals.push(element(doc, 'li', `${raw.subunits} raw subunits, asset unknown (${raw.medium})`));
  }
  if (totals.length === 0) {
    totals.push(element(doc, 'li', 'nothing credited yet', 'note'));
  }
  targets.totals.replaceChildren(...totals);
}

/** List the store's products read so far: id, title, price, and on sale or sold out. */
export function renderProducts(
  doc: Document,
  products: readonly ProductLine[],
  target: HTMLElement,
): void {
  const items = products.map((product) =>
    element(
      doc,
      'li',
      `${product.d}: ${product.title}, ${product.price}, ${product.onSale ? 'on sale' : 'sold out'}`,
      product.onSale ? undefined : 'note',
    ),
  );
  if (items.length === 0) {
    items.push(element(doc, 'li', 'no product read yet (the products your orders name)', 'note'));
  }
  target.replaceChildren(...items);
}
