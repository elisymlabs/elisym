import {
  type OrderRecord,
  isTerminal,
  storedFeePlan,
  storedSolanaRequest,
  storedTempoRequest,
} from '@elisym/commerce/buyer';
import Decimal from 'decimal.js-light';
import { openStatusOf, receiptBase, recordNetwork } from './receipts';
import { sameRef } from './ref-scope';
import type { OpenStatus, Receipt } from './session';
import { networkLabel, receiptField } from './ui/text';

export type PurchaseStatus = 'delivered' | 'refunded' | OpenStatus;

/**
 * One payment of the buyer's, as "Your purchases" shows and exports it: an
 * allowlist of what the record says, never the record itself. The one-time
 * buyer key, the signed wraps, the payment request, the attempt marker (with
 * its signed transaction), the reference, the payout address, the email and
 * any delivery an older node sent never leave this module.
 */
export interface Purchase {
  orderId: string;
  /** When the order was placed (seconds). */
  createdAt: number;
  status: PurchaseStatus;
  /** The same shape the receipt panel shows, without a sent transaction (checked on opening). */
  receipt: Receipt;
  /** The CAIP-19 id of the coin the order is for. */
  assetId: string;
  /** The order is for the product of this page's checkout. */
  thisProduct: boolean;
  /**
   * The protocol fee inside the price (subunits of the order's coin), from the
   * stored payment request; absent when it carries no fee leg.
   */
  feeAmount?: string;
}

/** The fee leg the order's stored request carries, in subunits, or none. */
function feeOf(record: OrderRecord): bigint {
  const request = record.payout.caip19.startsWith('eip155:')
    ? storedTempoRequest(record)
    : storedSolanaRequest(record);
  return request === undefined ? 0n : storedFeePlan(request).amount;
}

/** A purchase's status as the list, the detail and the export name it. */
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  delivered: 'Completed',
  refunded: 'Refunded',
  waiting_store: 'Waiting for the store',
  paying: 'Payment in progress',
  blocked: 'Payment blocked by the recipient',
  cancelled_paid: 'Cancelled by the store (no refund stated)',
};

export interface PurchaseScope {
  /** The store of the offer on screen: another store's orders on this site are never listed. */
  storePubkey: string;
  /** The page's account: only its orders (none on both counts as the same). */
  customerRef: string | undefined;
  /** The product of the offer on screen. */
  productAddress: string;
}

/** A payment the buyer made or started: finished, found, in progress or blocked. Unpaid orders are not. */
function isPayment(record: OrderRecord): boolean {
  return (
    isTerminal(record) ||
    record.state === 'paid' ||
    record.state === 'paying' ||
    record.state === 'blocked'
  );
}

function statusOf(record: OrderRecord): PurchaseStatus | undefined {
  if (record.state === 'completed') {
    return 'delivered';
  }
  if (record.state === 'refunded') {
    return 'refunded';
  }
  return openStatusOf(record);
}

/** One record as a purchase, or `undefined` when it is not a payment of the buyer's. */
export function purchaseOf(record: OrderRecord, productAddress: string): Purchase | undefined {
  const status = statusOf(record);
  if (status === undefined) {
    return undefined;
  }
  const fee = feeOf(record);
  return {
    orderId: record.orderId,
    createdAt: record.createdAt,
    status,
    receipt: receiptBase(record, recordNetwork(record)),
    assetId: record.payout.caip19,
    thisProduct: record.productAddress === productAddress,
    ...(fee > 0n ? { feeAmount: fee.toString() } : {}),
  };
}

/** This store's payments of the page's account, newest first. */
export function purchasesOf(records: readonly OrderRecord[], scope: PurchaseScope): Purchase[] {
  const purchases: Purchase[] = [];
  for (const record of records) {
    if (
      record.storePubkey !== scope.storePubkey ||
      !sameRef(record, scope.customerRef) ||
      !isPayment(record)
    ) {
      continue;
    }
    const purchase = purchaseOf(record, scope.productAddress);
    if (purchase !== undefined) {
      purchases.push(purchase);
    }
  }
  return purchases.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.orderId.localeCompare(right.orderId)
      : right.createdAt - left.createdAt,
  );
}

const CSV_COLUMNS = [
  'date',
  'store',
  'product',
  'status',
  'amount',
  'asset',
  'network',
  'asset_id',
  'order_id',
  'transaction',
  'explorer',
] as const;

/** A cell a spreadsheet would run as a formula: its first non-blank character starts one. */
const FORMULA_START = /^\s*[=+\-@\t\r]/;

/**
 * One CSV cell, already sanitized: a store-supplied value that a spreadsheet
 * would read as a formula gets a leading `'`; every cell is quoted, quotes doubled.
 */
function cell(value: string, storeSupplied = false): string {
  const safe = storeSupplied && FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** As `formatAssetAmount`: no exponent notation, and room for 18 decimals of a large amount. */
const AmountDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 50 });

/** The amount of an order in whole coins, from its subunits (never through `Number`). */
function wholeAmount(receipt: Receipt): string {
  const paying = receipt.paying;
  if (paying === undefined) {
    return '';
  }
  return new AmountDecimal(paying.amount)
    .div(new AmountDecimal(10).pow(paying.asset.decimals))
    .toString();
}

function csvRow(purchase: Purchase): string {
  const { receipt } = purchase;
  const paying = receipt.paying;
  return [
    cell(new Date(purchase.createdAt * 1000).toISOString()),
    cell(receiptField(receipt.store), true),
    cell(receiptField(receipt.product), true),
    cell(PURCHASE_STATUS_LABELS[purchase.status]),
    cell(wholeAmount(receipt)),
    cell(paying === undefined ? '' : paying.asset.symbol),
    cell(paying === undefined ? '' : networkLabel(paying.chain, paying.network)),
    cell(receiptField(purchase.assetId)),
    cell(receiptField(purchase.orderId)),
    // Only a payment this checkout confirmed: never a transaction nobody checked.
    cell(receipt.paid === undefined ? '' : receiptField(receipt.paid.tx)),
    cell(receipt.paid?.explorer ?? ''),
  ].join(',');
}

/** Read first by a spreadsheet: the file is UTF-8 (Excel guesses otherwise and garbles names). */
const UTF8_BOM = '\uFEFF';

/** The export: a byte order mark, a header row, then one row per purchase (CRLF line ends). */
export function purchasesCsv(purchases: readonly Purchase[]): string {
  return UTF8_BOM + [CSV_COLUMNS.join(','), ...purchases.map(csvRow)].join('\r\n') + '\r\n';
}

/** "elisym-purchases-my-shop-2026-10-05.csv". */
export function csvFileName(storeName: string | undefined, now: Date): string {
  const slug = (storeName ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const date = now.toISOString().slice(0, 10);
  return `elisym-purchases-${slug === '' ? 'store' : slug}-${date}.csv`;
}
