/**
 * The events the node sends, and their check. Never stricter than what the node
 * can emit: a field the node takes from the order (its id, the customer
 * reference, the product, the asset, the transaction) is checked for its type
 * and a generous length only. Formats are strict only where the node fixes the
 * value by construction and the money depends on it.
 */
import { HEX_PUBKEY_RE } from '../tags';

export interface WebhookPayment {
  /** CAIP-19 asset id the node verified (e.g. solana:<genesis>/token:<mint>). */
  asset: string;
  /** Decimal string of subunits verified on chain: credit this. */
  amount: string;
  /**
   * Approximate, for display only (may be exponent notation, e.g. "1e-9"); only for a coin the
   * node knows. Never credit from it.
   */
  amountDisplay?: string;
  /** Display only: take the decimals you credit with from your own asset list. */
  decimals?: number;
  symbol?: string;
  /** Transaction signature (Solana) or hash (Tempo): for records only. */
  tx: string;
  /** Receipt medium: solana, solana-devnet, tempo, tempo-moderato. Kept a string (open set). */
  medium: string;
  /** Unix seconds: the block time of the payment. */
  paidAt: number;
}

export interface OrderPaidWebhookEvent {
  event: 'order.paid';
  /** hex sha256(<store>:<buyer>:<orderId>:<payment signature>): the idempotency key. */
  eventId: string;
  /** The store's pubkey, hex: check it is yours. */
  store: string;
  orderId: string;
  buyerPubkey: string;
  /** Opaque: a lookup key, in parameterized queries only. */
  customerRef?: string;
  product: { address: string };
  payment: WebhookPayment;
  email?: string;
}

export interface TestWebhookEvent {
  event: 'test';
  eventId: string;
  store: string;
}

export type WebhookEvent = OrderPaidWebhookEvent | TestWebhookEvent;

/** A decimal integer string of subunits: no sign, no fraction, no leading zero, at most 39 digits. */
const SUBUNITS_RE = /^(0|[1-9][0-9]{0,38})$/;
const MAX_ORDER_ID_LENGTH = 256;
const MAX_CUSTOMER_REF_LENGTH = 256;
const MAX_ADDRESS_LENGTH = 512;
const MAX_ASSET_LENGTH = 512;
const MAX_AMOUNT_DISPLAY_LENGTH = 128;
const MAX_SYMBOL_LENGTH = 64;
const MAX_TX_LENGTH = 512;
const MAX_MEDIUM_LENGTH = 64;
const MAX_EMAIL_LENGTH = 512;
const MAX_DECIMALS = 255;

type JsonObject = Readonly<Record<string, unknown>>;

/** What the body's `event` says, before its shape is checked. */
export type EventClass = 'order.paid' | 'test' | 'unknown' | 'malformed';

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property only: nothing is read from a prototype. */
function own(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value !== '' && value.length <= maxLength;
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX_PUBKEY_RE.test(value);
}

export function classifyEvent(body: JsonObject): EventClass {
  const event = own(body, 'event');
  if (typeof event !== 'string') {
    return 'malformed';
  }
  if (event === 'order.paid' || event === 'test') {
    return event;
  }
  return 'unknown';
}

export function parseTestEvent(body: JsonObject): TestWebhookEvent | undefined {
  const eventId = own(body, 'eventId');
  const store = own(body, 'store');
  if (!isHex64(eventId) || !isHex64(store)) {
    return undefined;
  }
  return { event: 'test', eventId, store };
}

function parsePayment(value: unknown): WebhookPayment | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const asset = own(value, 'asset');
  const amount = own(value, 'amount');
  const amountDisplay = own(value, 'amountDisplay');
  const decimals = own(value, 'decimals');
  const symbol = own(value, 'symbol');
  const tx = own(value, 'tx');
  const medium = own(value, 'medium');
  const paidAt = own(value, 'paidAt');
  if (
    !isBoundedString(asset, MAX_ASSET_LENGTH) ||
    typeof amount !== 'string' ||
    !SUBUNITS_RE.test(amount) ||
    !isBoundedString(tx, MAX_TX_LENGTH) ||
    !isBoundedString(medium, MAX_MEDIUM_LENGTH) ||
    typeof paidAt !== 'number' ||
    !Number.isSafeInteger(paidAt) ||
    paidAt < 0
  ) {
    return undefined;
  }
  if (
    amountDisplay !== undefined &&
    (typeof amountDisplay !== 'string' || amountDisplay.length > MAX_AMOUNT_DISPLAY_LENGTH)
  ) {
    return undefined;
  }
  if (
    decimals !== undefined &&
    (typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > MAX_DECIMALS)
  ) {
    return undefined;
  }
  if (symbol !== undefined && !isBoundedString(symbol, MAX_SYMBOL_LENGTH)) {
    return undefined;
  }
  return {
    asset,
    amount,
    ...(amountDisplay === undefined ? {} : { amountDisplay }),
    ...(decimals === undefined ? {} : { decimals }),
    ...(symbol === undefined ? {} : { symbol }),
    tx,
    medium,
    paidAt,
  };
}

export function parseOrderPaidEvent(body: JsonObject): OrderPaidWebhookEvent | undefined {
  const eventId = own(body, 'eventId');
  const store = own(body, 'store');
  const orderId = own(body, 'orderId');
  const buyerPubkey = own(body, 'buyerPubkey');
  const customerRef = own(body, 'customerRef');
  const product = own(body, 'product');
  const email = own(body, 'email');
  if (
    !isHex64(eventId) ||
    !isHex64(store) ||
    !isBoundedString(orderId, MAX_ORDER_ID_LENGTH) ||
    !isHex64(buyerPubkey)
  ) {
    return undefined;
  }
  if (customerRef !== undefined && !isBoundedString(customerRef, MAX_CUSTOMER_REF_LENGTH)) {
    return undefined;
  }
  if (email !== undefined && !isBoundedString(email, MAX_EMAIL_LENGTH)) {
    return undefined;
  }
  if (!isJsonObject(product)) {
    return undefined;
  }
  const address = own(product, 'address');
  if (!isBoundedString(address, MAX_ADDRESS_LENGTH)) {
    return undefined;
  }
  const payment = parsePayment(own(body, 'payment'));
  if (payment === undefined) {
    return undefined;
  }
  return {
    event: 'order.paid',
    eventId,
    store,
    orderId,
    buyerPubkey,
    ...(customerRef === undefined ? {} : { customerRef }),
    product: { address },
    payment,
    ...(email === undefined ? {} : { email }),
  };
}
