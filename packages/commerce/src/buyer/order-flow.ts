import type { ChainConfig } from '@elisym/pay-core';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import {
  KIND_GIFT_WRAP,
  MAX_FUTURE_SKEW_SECS,
  type OrderStatusMessage,
  type OfferWarning,
  buildOrderMessage,
  deriveOrderPaymentReference,
  unwrapOrderMessage,
  wrapOrderMessage,
} from '../index';
import { MAX_CLOCK_SKEW_SECS, STORE_WRITE_ATTEMPTS, WRAP_BACKDATE_SECS } from './constants';
import { readStoreInbox } from './inbox';
import { type LoadedOffer, type PricedPayout, isSnapshotStale } from './offer';
import { type OrderRecord, type OrderStatus, isTerminal } from './order-record';
import type { OrderStore, StoreWrite } from './order-store';
import type { RelayClient } from './relay-client';
import { storeRelays } from './relays';

type ReadyOffer = Extract<LoadedOffer, { ok: true }>;

/** The receipt `medium` of a chain: `solana`, `solana-devnet`, `tempo`, `tempo-moderato`. */
export function mediumOf(chain: Pick<ChainConfig, 'slug' | 'network'>): string {
  if (chain.network === 'mainnet') {
    return chain.slug;
  }
  return chain.slug === 'tempo' ? 'tempo-moderato' : `${chain.slug}-${chain.network}`;
}

/**
 * Whether the device clock is close enough to chain time to order: the rumor is
 * dated by the chain, but the seal and the wrap by the device, and the widget
 * drops a store status dated ahead of it - a slow clock would lose the delivery.
 */
export function clockAgrees(chainTime: number, deviceTime: number): boolean {
  return Math.abs(chainTime - deviceTime) <= MAX_CLOCK_SKEW_SECS;
}

/**
 * How a fresh offer compares with the one the buyer confirmed: the same payout
 * and price and no new warning to confirm (`same`); something the buyer must
 * look at again (`changed`); or the chosen payout is gone (`gone`).
 */
export function compareOffers(
  shown: PricedPayout,
  confirmed: readonly OfferWarning[],
  fresh: ReadyOffer,
): 'same' | 'changed' | 'gone' {
  const match = fresh.payouts.find(
    (payout) =>
      payout.target.caip19.id === shown.target.caip19.id &&
      payout.target.address === shown.target.address,
  );
  if (match === undefined) {
    return 'gone';
  }
  if (match.amount !== shown.amount) {
    return 'changed';
  }
  return fresh.confirm.every((warning) => confirmed.includes(warning)) ? 'same' : 'changed';
}

export interface PlaceOrderInput {
  /** A FRESH verified offer (at most two minutes old). */
  offer: ReadyOffer;
  payout: PricedPayout;
  email?: string;
  /** The merchant's id for the account to credit; travels in the order and stays on the record. */
  customerRef?: string;
  /** Chain time read just before ordering (seconds). */
  chainTime: number;
  /** The device clock at the same moment (seconds). */
  deviceTime: number;
}

export interface OrderDeps {
  store: OrderStore;
  /** Reads (the offer, the inbox list): no key. */
  readClient: RelayClient;
  /**
   * A NEW client for one order's writes, answering AUTH with its buyer key. The
   * callee owns it and closes it when done, so it must never be one the caller
   * also listens with.
   */
  clientFor: (buyerSecretKey: Uint8Array) => RelayClient;
}

export type PlaceOrderResult =
  | { ok: true; record: OrderRecord }
  | {
      ok: false;
      reason:
        /** The device clock is too far from chain time. */
        | 'clock_skew'
        /** The offer is older than two minutes, or the payout is not one of its own: verify again. */
        | 'stale_offer'
        /** The store names no usable inbox relay: nowhere to send the order. */
        | 'no_store_inbox'
        /** The order went out but too few inbox relays took it; `resume` may try again. */
        | 'not_acknowledged';
      record?: OrderRecord;
    };

/**
 * Place a direct-mode order: a fresh one-time buyer key, a random order id, the
 * reference derived from them, the order sealed and gift-wrapped to the store,
 * recorded, then sent to the store's CURRENT inbox relays. It counts as placed
 * only once enough of them said OK - the wallet opens only after that, since the
 * merchant cannot attribute a payment without its order.
 */
export async function placeOrder(
  input: PlaceOrderInput,
  deps: OrderDeps,
): Promise<PlaceOrderResult> {
  const { offer, payout } = input;
  if (!clockAgrees(input.chainTime, input.deviceTime)) {
    return { ok: false, reason: 'clock_skew' };
  }
  // The order is placed at the price and payout of THIS fresh offer, nothing older.
  const offered = offer.payouts.some(
    (candidate) =>
      candidate.target.caip19.id === payout.target.caip19.id &&
      candidate.target.address === payout.target.address &&
      candidate.amount === payout.amount,
  );
  if (isSnapshotStale(offer.snapshotAt, input.deviceTime) || !offered) {
    return { ok: false, reason: 'stale_offer' };
  }
  const storePubkey = offer.offer.storePubkey;
  const inbox = await readStoreInbox(
    deps.readClient,
    { hints: offer.hints },
    storePubkey,
    input.deviceTime,
  );
  if (inbox === undefined) {
    return { ok: false, reason: 'no_store_inbox' };
  }
  const buyerKey = generateSecretKey();
  const buyerPubkey = getPublicKey(buyerKey);
  const orderId = crypto.randomUUID();
  const reference = deriveOrderPaymentReference({ storePubkey, buyerPubkey, orderId });
  const rumor = buildOrderMessage(
    {
      type: 'order',
      storePubkey,
      orderId,
      items: [{ product: offer.productAddress, quantity: 1 }],
      total: {
        amount: offer.offer.product.price.amount,
        currency: offer.offer.product.price.currency,
      },
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.customerRef === undefined ? {} : { customerRef: input.customerRef }),
    },
    input.chainTime,
  );
  const wrapped = wrapOrderMessage(rumor, buyerKey, storePubkey);
  const chain = payout.target.caip19.chain;
  const record: OrderRecord = {
    orderId,
    productAddress: offer.productAddress,
    storePubkey,
    buyerSecretKey: bytesToHex(buyerKey),
    buyerPubkey,
    createdAt: input.chainTime,
    version: 1,
    state: 'created',
    payout: { caip19: payout.target.caip19.id, address: payout.target.address },
    amount: payout.amount.toString(),
    medium: mediumOf(chain),
    reference: chain.family === 'solana' ? reference.solana : reference.tempo,
    offer: offer.offer,
    ...(input.customerRef === undefined ? {} : { customerRef: input.customerRef }),
    // Kept before it is sent: a crash in between is resumed by sending the same wrap.
    orderWrap: wrapped.recipientWrap,
    inboxRelays: inbox.relays,
    acknowledgedRelays: [],
  };
  await deps.store.add(record);
  return acknowledge(record, inbox.relays, inbox.relays, deps);
}

/**
 * Send the order wrap to `sendTo` and, once enough of the store's CURRENT inbox
 * relays (`inbox`) took it, move the record to `ordered`. Relays that left the
 * inbox may still hold the order, but never count.
 */
async function acknowledge(
  record: OrderRecord,
  sendTo: readonly string[],
  inbox: readonly string[],
  deps: OrderDeps,
): Promise<PlaceOrderResult> {
  if (record.orderWrap === undefined) {
    return { ok: false, reason: 'not_acknowledged', record };
  }
  const client = deps.clientFor(hexToBytes(record.buyerSecretKey));
  try {
    const sent = await client.publish(sendTo, record.orderWrap);
    let current = record;
    // Another tab may write the record meanwhile: merge this tab's acknowledgements
    // into what is stored and try again, a bounded number of times.
    for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS; attempt += 1) {
      const acknowledged = [...new Set([...current.acknowledgedRelays, ...sent.accepted])];
      const written = await deps.store.update(current.orderId, current.version, {
        state: 'ordered',
        inboxRelays: [...inbox],
        acknowledgedRelays: acknowledged,
      });
      if (written.ok) {
        return { ok: true, record: await settleHeldStatus(deps.store, written.record) };
      }
      if (written.reason !== 'conflict') {
        // Too few took it: keep who did, so a later attempt adds to them.
        const kept = await deps.store.update(current.orderId, current.version, {
          inboxRelays: [...inbox],
          acknowledgedRelays: acknowledged,
        });
        if (kept.ok) {
          return { ok: false, reason: 'not_acknowledged', record: kept.record };
        }
        if (kept.reason !== 'conflict') {
          return { ok: false, reason: 'not_acknowledged', record: current };
        }
      }
      const stored = await deps.store.get(current.orderId);
      if (stored === undefined) {
        return { ok: false, reason: 'not_acknowledged', record: current };
      }
      // Another tab ordered it: report what is stored, not this stale copy.
      if (stored.state !== 'created') {
        return { ok: true, record: stored };
      }
      current = stored;
    }
    return { ok: false, reason: 'not_acknowledged', record: current };
  } finally {
    client.close();
  }
}

/**
 * The buyer's receipt (kind 17) once a payment went out: the medium, the derived
 * reference and the transaction, sealed by the buyer key, recorded (for byte-for-
 * byte republishing) and sent to the order's inbox relays.
 */
export async function sendReceipt(
  record: OrderRecord,
  tx: string,
  createdAt: number,
  deps: OrderDeps,
): Promise<StoreWrite> {
  const buyerKey = hexToBytes(record.buyerSecretKey);
  const rumor = buildOrderMessage(
    {
      type: 'receipt',
      storePubkey: record.storePubkey,
      orderId: record.orderId,
      payment: { medium: record.medium, reference: record.reference, tx },
    },
    createdAt,
  );
  const wrapped = wrapOrderMessage(rumor, buyerKey, record.storePubkey);
  const written = await deps.store.update(record.orderId, record.version, {
    receiptWrap: wrapped.recipientWrap,
  });
  if (written.ok) {
    const client = deps.clientFor(buyerKey);
    try {
      await client.publish(record.inboxRelays, wrapped.recipientWrap);
    } finally {
      client.close();
    }
  }
  return written;
}

/**
 * On resume: read the store's inbox list again, and republish the SAME order and
 * receipt wraps byte for byte to the union of its current inbox and the relays
 * that took the order before (capped); a record not yet acknowledged may become
 * so here. Returns the relays to listen on for the store's status.
 */
export async function resumeOrder(
  record: OrderRecord,
  deps: OrderDeps,
  now: number,
): Promise<{ record: OrderRecord; relays: string[] }> {
  const fresh = await readStoreInbox(
    deps.readClient,
    { acknowledged: record.acknowledgedRelays },
    record.storePubkey,
    now,
  );
  const relays = storeRelays({
    inbox: fresh?.relays ?? record.inboxRelays,
    acknowledged: record.acknowledgedRelays,
  });
  if (record.state === 'created') {
    // No valid store inbox list: nowhere the store is known to read, so no order.
    if (fresh === undefined) {
      return { record, relays };
    }
    const placed = await acknowledge(record, relays, fresh.relays, deps);
    return { record: placed.record ?? record, relays };
  }
  const client = deps.clientFor(hexToBytes(record.buyerSecretKey));
  try {
    for (const wrap of [record.orderWrap, record.receiptWrap]) {
      if (wrap !== undefined) {
        await client.publish(relays, wrap);
      }
    }
  } finally {
    client.close();
  }
  // Receipts sent from now on go where the store reads today.
  // Written only when it changed: every write bumps the version another tab's
  // payment writes are checked against.
  const sameInbox =
    fresh !== undefined &&
    fresh.relays.length === record.inboxRelays.length &&
    fresh.relays.every((relay, index) => record.inboxRelays[index] === relay);
  if (fresh !== undefined && !sameInbox && !isTerminal(record)) {
    const moved = await deps.store.update(record.orderId, record.version, {
      inboxRelays: fresh.relays,
    });
    if (moved.ok) {
      return { record: moved.record, relays };
    }
  }
  return { record, relays };
}

/**
 * A store status for this record, or `undefined`: sealed by the store key, for
 * this order id, naming this record's buyer key. Anything else - another
 * sender, another order, another buyer - is not this order's answer.
 */
export function statusFor(record: OrderRecord, wrap: NostrEvent): OrderStatusMessage | undefined {
  const unwrapped = unwrapOrderMessage(wrap, hexToBytes(record.buyerSecretKey));
  if (
    unwrapped === undefined ||
    unwrapped.senderPubkey !== record.storePubkey ||
    unwrapped.message.type !== 'status' ||
    unwrapped.message.orderId !== record.orderId ||
    unwrapped.message.buyerPubkey !== record.buyerPubkey
  ) {
    return undefined;
  }
  return unwrapped.message;
}

/** The delivery as a link, only when it is `https:`; anything else is shown as text. */
export function deliveryLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The state a store status settles: delivered, or cancelled with a refund. */
function settledState(message: OrderStatusMessage): 'completed' | 'refunded' | undefined {
  if (message.status === 'completed') {
    return 'completed';
  }
  if (message.status === 'cancelled' && message.refund !== undefined) {
    return 'refunded';
  }
  return undefined;
}

/** TOFU: the owner, and every payout of the offer that delivered. */
async function rememberDelivery(store: OrderStore, record: OrderRecord): Promise<void> {
  await store.rememberDelivery(
    record.storePubkey,
    record.offer.ownerPubkey,
    record.offer.payouts.map((target) => ({ caip19: target.caip19.id, address: target.address })),
  );
}

/**
 * A settling status heard while the order was not yet acknowledged was kept
 * alone; once the record is ordered it settles now (the same wrap is not handed
 * on again this session). Left as it is on a concurrent change: the next
 * subscription hears the status again.
 */
async function settleHeldStatus(store: OrderStore, record: OrderRecord): Promise<OrderRecord> {
  const held = record.status;
  let settles: 'completed' | 'refunded' | undefined;
  if (held?.status === 'completed') {
    settles = 'completed';
  } else if (held?.status === 'cancelled' && held.refunded === true) {
    settles = 'refunded';
  }
  if (settles === undefined) {
    return record;
  }
  const settled = await store.update(record.orderId, record.version, { state: settles });
  if (!settled.ok) {
    return record;
  }
  if (settles === 'completed') {
    await rememberDelivery(store, settled.record);
  }
  return settled.record;
}

/**
 * Record a store status: the status itself (it only moves forward), and the
 * state it settles - `completed` on delivery, `refunded` on a cancellation with
 * a refund. The write retries on a concurrent change; a status the record can no
 * longer take is left out.
 */
export async function applyStatus(
  store: OrderStore,
  orderId: string,
  message: OrderStatusMessage,
  at: number,
): Promise<OrderRecord | undefined> {
  const status: OrderStatus = {
    status: message.status,
    at,
    ...(message.delivery === undefined ? {} : { delivery: message.delivery.value }),
    ...(message.refund === undefined ? {} : { refunded: true }),
  };
  for (let attempt = 0; attempt < STORE_WRITE_ATTEMPTS; attempt += 1) {
    const current = await store.get(orderId);
    if (current === undefined) {
      return undefined;
    }
    const settles = settledState(message);
    const heardBefore =
      current.status?.status === status.status &&
      current.status.delivery === status.delivery &&
      current.status.refunded === status.refunded;
    // Heard again (a re-read, another relay): nothing new, no write - unless the
    // record could not settle when it was first heard and may now.
    if (heardBefore && (settles === undefined || current.state === settles)) {
      return current;
    }
    const withState = await store.update(orderId, current.version, {
      status,
      ...(settles === undefined ? {} : { state: settles }),
    });
    if (withState.ok) {
      if (settles === 'completed') {
        await rememberDelivery(store, withState.record);
      }
      return withState.record;
    }
    if (withState.reason === 'conflict') {
      continue;
    }
    // The state cannot move (e.g. not yet ordered): keep the status alone.
    if (heardBefore) {
      return current;
    }
    const alone = await store.update(orderId, current.version, { status });
    if (alone.ok) {
      return alone.record;
    }
    if (alone.reason !== 'conflict') {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Listen for the store's status on `relays`: gift wraps to the buyer key from
 * the order's date back two days and the skew (NIP-59 back-dates wraps), each
 * checked by `statusFor` before it is handed on. It listens with its own client
 * that answers AUTH with the buyer key (inbox relays often ask for it before
 * serving gift wraps), closed with the subscription.
 */
export function listenForStatus(
  record: OrderRecord,
  relays: readonly string[],
  deps: Pick<OrderDeps, 'clientFor'>,
  onStatus: (message: OrderStatusMessage) => void,
): { close(): void } {
  const client = deps.clientFor(hexToBytes(record.buyerSecretKey));
  const subscription = client.subscribe(
    relays,
    {
      kinds: [KIND_GIFT_WRAP],
      '#p': [record.buyerPubkey],
      since: record.createdAt - WRAP_BACKDATE_SECS - MAX_FUTURE_SKEW_SECS,
    },
    (wrap) => {
      const status = statusFor(record, wrap);
      if (status !== undefined) {
        onStatus(status);
      }
    },
  );
  return {
    close() {
      subscription.close();
      client.close();
    },
  };
}
