import {
  type OrderMessage,
  type OrderRequest,
  type UnwrappedOrderMessage,
  buildOrderMessage,
  deriveOrderPaymentReference,
  wrapOrderMessage,
} from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { AdminStore } from '../../src/admin/history';

export const T0 = 1_790_000_000;
export const D = 'course-101';
export const USDC_DEVNET_CAIP19 =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** Well-formed Solana signatures (64 bytes of 1, then of 2, in base58). */
export const TX1 =
  '2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2';
export const TX2 =
  '3L3RY5sT8K4kyEnqhizwaqxLEbcYvpGrGPNEYRwtbCSUtL6YL86jdrvCbohnP5q8VxQ3qzGmt3W3iQJW97rD7m3';

export interface Key {
  secretKey: Uint8Array;
  pubkey: string;
}

export function key(): Key {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

let counter = 0;

/** A message as `unwrapOrderMessage` would hand it on: the seal signer and the rumor's `p`. */
export function message(
  body: OrderMessage,
  senderPubkey: string,
  recipientPubkey: string,
  createdAt = T0 + 60,
): UnwrappedOrderMessage {
  counter += 1;
  return {
    rumorId: counter.toString(16).padStart(64, '0'),
    senderPubkey,
    recipientPubkey,
    createdAt,
    message: body,
  };
}

export function productOf(store: Key, d = D): string {
  return `30402:${store.pubkey}:${d}`;
}

/** A store selling `D` at 1 USD since `T0`, on Solana devnet. */
export function adminStore(store: Key, overrides: Partial<AdminStore> = {}): AdminStore {
  return {
    storePubkey: store.pubkey,
    productAddresses: new Set([productOf(store)]),
    mediums: ['solana-devnet'],
    listings: new Map([
      [
        productOf(store),
        { price: { amount: '1', currency: 'USD' }, createdAt: T0, title: 'Course' },
      ],
    ]),
    ...overrides,
  };
}

export function orderBody(
  store: Key,
  orderId: string,
  overrides: Partial<OrderRequest> = {},
): OrderRequest {
  return {
    type: 'order',
    storePubkey: store.pubkey,
    orderId,
    items: [{ product: productOf(store), quantity: 1 }],
    total: { amount: '1', currency: 'USD' },
    ...overrides,
  };
}

export function receiptBody(store: Key, buyer: Key, orderId: string, tx = TX1) {
  return {
    type: 'receipt' as const,
    storePubkey: store.pubkey,
    orderId,
    payment: {
      medium: 'solana-devnet',
      reference: deriveOrderPaymentReference({
        storePubkey: store.pubkey,
        buyerPubkey: buyer.pubkey,
        orderId,
      }).solana,
      tx,
    },
  };
}

export function deliveredBody(
  buyer: Key,
  orderId: string,
  receipt: { tx?: string; amount?: string; caip19?: string; medium?: string } = {},
) {
  return {
    type: 'status' as const,
    buyerPubkey: buyer.pubkey,
    orderId,
    status: 'completed' as const,
    receipt: {
      medium: receipt.medium ?? 'solana-devnet',
      tx: receipt.tx ?? TX1,
      amount: receipt.amount ?? '1000000',
      fee: '0',
      ...(receipt.caip19 === undefined ? {} : { caip19: receipt.caip19 }),
    },
  };
}

/** A real gift wrap of `body` from `sender` to `recipient`, the rumor dated `createdAt`. */
export function wrapOf(
  body: OrderMessage,
  sender: Key,
  recipient: Key,
  createdAt = T0 + 60,
): NostrEvent {
  return wrapOrderMessage(buildOrderMessage(body, createdAt), sender.secretKey, recipient.pubkey)
    .recipientWrap;
}

/** The store's own copy of its answer to `buyer`, as the node publishes it to its inbox. */
export function selfCopyOf(body: OrderMessage, store: Key, buyer: Key, createdAt = T0 + 120) {
  return wrapOrderMessage(buildOrderMessage(body, createdAt), store.secretKey, buyer.pubkey)
    .selfWrap;
}
