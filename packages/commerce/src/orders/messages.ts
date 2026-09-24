import type { EventTemplate } from 'nostr-tools';
import {
  DELIVERY_METHODS,
  type DeliveryMethod,
  KIND_ORDER_MESSAGE,
  KIND_PAYMENT_RECEIPT,
  KIND_PRODUCT,
  LIMITS,
  ORDER_STATUSES,
  type OrderStatus,
} from '../constants';
import { HEX_PUBKEY_RE, type Tags, nowSecs, tagValue, tagsNamed } from '../tags';

const ORDER_ID_RE = new RegExp(`^[A-Za-z0-9-]{8,${LIMITS.MAX_ORDER_ID_LENGTH}}$`);
const ITEM_ADDRESS_RE = new RegExp(`^${KIND_PRODUCT}:[0-9a-f]{64}:[A-Za-z0-9._:-]{1,128}$`);
const QUANTITY_RE = /^[1-9]\d{0,3}$/;
const AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
const SUBUNITS_RE = /^(0|[1-9]\d{0,38})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MEDIUM_RE = /^[a-z0-9-]{1,32}$/;
const TX_RE = /^[A-Za-z0-9]{1,128}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const ORDER_MESSAGE_TYPES: readonly string[] = ['order', 'payment_request', 'status', 'receipt'];

/** Gamma Markets `type` values for kind 16. */
const TYPE_ORDER = '1';
const TYPE_PAYMENT_REQUEST = '2';
const TYPE_STATUS = '3';

export interface OrderItem {
  /** `30402:<store>:<d>` */
  product: string;
  quantity: number;
}

export interface Money {
  /** Decimal string, never a float. */
  amount: string;
  currency: string;
}

/** Buyer -> store: kind 16, type 1. */
export interface OrderRequest {
  type: 'order';
  storePubkey: string;
  orderId: string;
  items: OrderItem[];
  total: Money;
  email?: string;
}

/** Store -> buyer: kind 16, type 2 (quoted mode). `payload` is opaque here: the payer parses it with pay-core. */
export interface PaymentRequestMessage {
  type: 'payment_request';
  buyerPubkey: string;
  orderId: string;
  total: Money;
  options: { medium: string; payload: string }[];
}

/** Store -> buyer: kind 16, type 3. Signed by the store, so it is the proof of purchase. */
export interface OrderStatusMessage {
  type: 'status';
  buyerPubkey: string;
  orderId: string;
  status: OrderStatus;
  /** Store-supplied and unchecked: show it as text, or open it only as an `https:` link. */
  delivery?: { method: DeliveryMethod; value: string };
  /** The payment the store credited: amounts in subunits of the paid asset. */
  receipt?: { medium: string; tx: string; amount: string; fee: string };
  refund?: { tx: string; amount: string };
}

/**
 * Buyer -> store: kind 17. A HINT that says where to look, never proof: the
 * store verifies the transaction on chain before it credits anything.
 */
export interface PaymentReceipt {
  type: 'receipt';
  storePubkey: string;
  orderId: string;
  payment: { medium: string; reference: string; tx: string };
}

export type OrderMessage =
  | OrderRequest
  | PaymentRequestMessage
  | OrderStatusMessage
  | PaymentReceipt;

function assertPubkey(value: string, name: string): void {
  if (!HEX_PUBKEY_RE.test(value)) {
    throw new Error(`${name} must be 64 lowercase hex characters`);
  }
}

function assertMatches(value: string, pattern: RegExp, name: string): void {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function assertMoney(money: Money): void {
  assertMatches(money.amount, AMOUNT_RE, 'amount');
  assertMatches(money.currency, CURRENCY_RE, 'currency');
}

/**
 * The unsigned rumor for an order message. It is never published as is: it goes
 * through `wrapOrderMessage`, which seals it with the sender's key.
 */
export function buildOrderMessage(
  message: OrderMessage,
  createdAt: number = nowSecs(),
): EventTemplate {
  // A plain-JS caller gets a clear error here, not `undefined` from the switch.
  if (!ORDER_MESSAGE_TYPES.some((known) => known === message.type)) {
    throw new Error(`Unknown order message type: ${String(message.type)}`);
  }
  assertMatches(message.orderId, ORDER_ID_RE, 'order id');
  switch (message.type) {
    case 'order': {
      assertPubkey(message.storePubkey, 'storePubkey');
      assertMoney(message.total);
      if (message.items.length === 0 || message.items.length > LIMITS.MAX_ITEMS_PER_ORDER) {
        throw new Error(`An order holds 1 to ${LIMITS.MAX_ITEMS_PER_ORDER} items`);
      }
      const tags: string[][] = [
        ['p', message.storePubkey],
        ['subject', 'order'],
        ['type', TYPE_ORDER],
        ['order', message.orderId],
      ];
      for (const item of message.items) {
        assertMatches(item.product, ITEM_ADDRESS_RE, 'item');
        assertMatches(String(item.quantity), QUANTITY_RE, 'quantity');
        tags.push(['item', item.product, String(item.quantity)]);
      }
      tags.push(['amount', message.total.amount, message.total.currency]);
      if (message.email !== undefined) {
        assertMatches(message.email, EMAIL_RE, 'email');
        tags.push(['email', message.email]);
      }
      return { kind: KIND_ORDER_MESSAGE, created_at: createdAt, tags, content: '' };
    }
    case 'payment_request': {
      assertPubkey(message.buyerPubkey, 'buyerPubkey');
      assertMoney(message.total);
      if (message.options.length === 0) {
        throw new Error('A payment request offers at least one way to pay');
      }
      const tags: string[][] = [
        ['p', message.buyerPubkey],
        ['type', TYPE_PAYMENT_REQUEST],
        ['order', message.orderId],
        ['amount', message.total.amount, message.total.currency],
      ];
      for (const option of message.options) {
        assertMatches(option.medium, MEDIUM_RE, 'payment medium');
        if (
          option.payload.length === 0 ||
          option.payload.length > LIMITS.MAX_TAG_VALUE_LENGTH * 4
        ) {
          throw new Error('Payment payload is empty or too long');
        }
        tags.push(['payment', option.medium, option.payload]);
      }
      return { kind: KIND_ORDER_MESSAGE, created_at: createdAt, tags, content: '' };
    }
    case 'status': {
      assertPubkey(message.buyerPubkey, 'buyerPubkey');
      if (!ORDER_STATUSES.some((status) => status === message.status)) {
        throw new Error(`Invalid order status: ${message.status}`);
      }
      const tags: string[][] = [
        ['p', message.buyerPubkey],
        ['type', TYPE_STATUS],
        ['order', message.orderId],
        ['status', message.status],
      ];
      if (message.delivery !== undefined) {
        const { method, value } = message.delivery;
        if (!DELIVERY_METHODS.some((known) => known === method)) {
          throw new Error(`Invalid delivery method: ${method}`);
        }
        if (value.length === 0 || value.length > LIMITS.MAX_TAG_VALUE_LENGTH) {
          throw new Error('Delivery value is empty or too long');
        }
        tags.push(['delivery', message.delivery.method, message.delivery.value]);
      }
      if (message.receipt !== undefined) {
        assertMatches(message.receipt.medium, MEDIUM_RE, 'receipt medium');
        assertMatches(message.receipt.tx, TX_RE, 'receipt tx');
        assertMatches(message.receipt.amount, SUBUNITS_RE, 'receipt amount');
        assertMatches(message.receipt.fee, SUBUNITS_RE, 'receipt fee');
        tags.push([
          'receipt',
          message.receipt.medium,
          message.receipt.tx,
          message.receipt.amount,
          message.receipt.fee,
        ]);
      }
      if (message.refund !== undefined) {
        assertMatches(message.refund.tx, TX_RE, 'refund tx');
        assertMatches(message.refund.amount, SUBUNITS_RE, 'refund amount');
        tags.push(['refund', message.refund.tx, message.refund.amount]);
      }
      return { kind: KIND_ORDER_MESSAGE, created_at: createdAt, tags, content: '' };
    }
    case 'receipt': {
      assertPubkey(message.storePubkey, 'storePubkey');
      assertMatches(message.payment.medium, MEDIUM_RE, 'payment medium');
      assertMatches(message.payment.reference, TX_RE, 'payment reference');
      assertMatches(message.payment.tx, TX_RE, 'payment tx');
      return {
        kind: KIND_PAYMENT_RECEIPT,
        created_at: createdAt,
        tags: [
          ['p', message.storePubkey],
          ['order', message.orderId],
          ['payment', message.payment.medium, message.payment.reference, message.payment.tx],
        ],
        content: '',
      };
    }
  }
}

function readMoney(tags: Tags): Money | undefined {
  const tag = tagsNamed(tags, 'amount')[0];
  const amount = tag?.[1];
  const currency = tag?.[2];
  if (!amount || !AMOUNT_RE.test(amount) || !currency || !CURRENCY_RE.test(currency)) {
    return undefined;
  }
  return { amount, currency };
}

function readPubkey(tags: Tags): string | undefined {
  const value = tagValue(tags, 'p');
  return value !== undefined && HEX_PUBKEY_RE.test(value) ? value : undefined;
}

function readOrderRequest(tags: Tags, orderId: string): OrderRequest | undefined {
  const storePubkey = readPubkey(tags);
  const total = readMoney(tags);
  const itemTags = tagsNamed(tags, 'item');
  if (
    !storePubkey ||
    !total ||
    itemTags.length === 0 ||
    itemTags.length > LIMITS.MAX_ITEMS_PER_ORDER
  ) {
    return undefined;
  }
  const items: OrderItem[] = [];
  for (const tag of itemTags) {
    const product = tag[1];
    const quantity = tag[2] ?? '1';
    if (!product || !ITEM_ADDRESS_RE.test(product) || !QUANTITY_RE.test(quantity)) {
      return undefined;
    }
    items.push({ product, quantity: Number(quantity) });
  }
  const order: OrderRequest = { type: 'order', storePubkey, orderId, items, total };
  const email = tagValue(tags, 'email');
  if (email !== undefined && EMAIL_RE.test(email)) {
    order.email = email;
  }
  return order;
}

function readPaymentRequest(tags: Tags, orderId: string): PaymentRequestMessage | undefined {
  const buyerPubkey = readPubkey(tags);
  const total = readMoney(tags);
  if (!buyerPubkey || !total) {
    return undefined;
  }
  const options: PaymentRequestMessage['options'] = [];
  for (const tag of tagsNamed(tags, 'payment')) {
    const medium = tag[1];
    const payload = tag[2];
    if (medium && MEDIUM_RE.test(medium) && payload) {
      options.push({ medium, payload });
    }
  }
  if (options.length === 0) {
    return undefined;
  }
  return { type: 'payment_request', buyerPubkey, orderId, total, options };
}

function readStatus(tags: Tags, orderId: string): OrderStatusMessage | undefined {
  const buyerPubkey = readPubkey(tags);
  const statusValue = tagValue(tags, 'status');
  const status = ORDER_STATUSES.find((candidate) => candidate === statusValue);
  if (!buyerPubkey || !status) {
    return undefined;
  }
  const message: OrderStatusMessage = { type: 'status', buyerPubkey, orderId, status };
  const deliveryTag = tagsNamed(tags, 'delivery')[0];
  const method = DELIVERY_METHODS.find((candidate) => candidate === deliveryTag?.[1]);
  const deliveryValue = deliveryTag?.[2];
  if (method && deliveryValue && deliveryValue.length <= LIMITS.MAX_TAG_VALUE_LENGTH) {
    message.delivery = { method, value: deliveryValue };
  }
  const receiptTag = tagsNamed(tags, 'receipt')[0];
  const [, medium, tx, amount, fee] = receiptTag ?? [];
  if (
    medium &&
    MEDIUM_RE.test(medium) &&
    tx &&
    TX_RE.test(tx) &&
    amount &&
    SUBUNITS_RE.test(amount) &&
    fee &&
    SUBUNITS_RE.test(fee)
  ) {
    message.receipt = { medium, tx, amount, fee };
  }
  const refundTag = tagsNamed(tags, 'refund')[0];
  const [, refundTx, refundAmount] = refundTag ?? [];
  if (refundTx && TX_RE.test(refundTx) && refundAmount && SUBUNITS_RE.test(refundAmount)) {
    message.refund = { tx: refundTx, amount: refundAmount };
  }
  return message;
}

function readReceipt(tags: Tags, orderId: string): PaymentReceipt | undefined {
  const storePubkey = readPubkey(tags);
  const [, medium, reference, tx] = tagsNamed(tags, 'payment')[0] ?? [];
  if (
    !storePubkey ||
    !medium ||
    !MEDIUM_RE.test(medium) ||
    !reference ||
    !TX_RE.test(reference) ||
    !tx ||
    !TX_RE.test(tx)
  ) {
    return undefined;
  }
  return { type: 'receipt', storePubkey, orderId, payment: { medium, reference, tx } };
}

/**
 * Read an unwrapped rumor as an order message, or `undefined` when it is not a
 * well-formed one. Who SENT it is not checked here: `unwrapOrderMessage` gives
 * the authenticated sender, and the caller matches it against the role (a status
 * must come from the store, an order from the buyer who pays).
 */
export function parseOrderMessage(rumor: { kind: number; tags: Tags }): OrderMessage | undefined {
  const orderId = tagValue(rumor.tags, 'order');
  if (orderId === undefined || !ORDER_ID_RE.test(orderId)) {
    return undefined;
  }
  if (rumor.kind === KIND_PAYMENT_RECEIPT) {
    return readReceipt(rumor.tags, orderId);
  }
  if (rumor.kind !== KIND_ORDER_MESSAGE) {
    return undefined;
  }
  switch (tagValue(rumor.tags, 'type')) {
    case TYPE_ORDER:
      return readOrderRequest(rumor.tags, orderId);
    case TYPE_PAYMENT_REQUEST:
      return readPaymentRequest(rumor.tags, orderId);
    case TYPE_STATUS:
      return readStatus(rumor.tags, orderId);
    default:
      return undefined;
  }
}
