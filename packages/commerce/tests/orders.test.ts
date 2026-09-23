import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import * as nip59 from 'nostr-tools/nip59';
import { describe, expect, it } from 'vitest';
import { KIND_GIFT_WRAP, KIND_ORDER_MESSAGE, KIND_SEAL } from '../src/constants';
import { unwrapOrderMessage, wrapOrderMessage } from '../src/orders/gift-wrap';
import {
  type OrderMessage,
  type OrderRequest,
  type PaymentReceipt,
  buildOrderMessage,
  parseOrderMessage,
} from '../src/orders/messages';
import { nostrKey } from './fixtures';

const STORE = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const ORDER_ID = '8f14e45f-ceea-467a-9575-1b2c3d4e5f60';
const ITEM = `30402:${STORE}:course-101`;

const ORDER: OrderRequest = {
  type: 'order',
  storePubkey: STORE,
  orderId: ORDER_ID,
  items: [{ product: ITEM, quantity: 1 }],
  total: { amount: '49', currency: 'USD' },
  email: 'buyer@example.com',
};

const RECEIPT: PaymentReceipt = {
  type: 'receipt',
  storePubkey: STORE,
  orderId: ORDER_ID,
  payment: { medium: 'solana', reference: 'RefPubkey111', tx: '5xSig' },
};

const MESSAGES: OrderMessage[] = [
  ORDER,
  {
    type: 'payment_request',
    buyerPubkey: BUYER,
    orderId: ORDER_ID,
    total: { amount: '49', currency: 'USD' },
    options: [{ medium: 'elisym-v2', payload: 'eyJ2IjoyfQ' }],
  },
  {
    type: 'status',
    buyerPubkey: BUYER,
    orderId: ORDER_ID,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course?token=t' },
    receipt: { medium: 'solana', tx: '5xSig', amount: '49000000', fee: '0' },
  },
  {
    type: 'status',
    buyerPubkey: BUYER,
    orderId: ORDER_ID,
    status: 'cancelled',
    refund: { tx: '4xRefund', amount: '49000000' },
  },
  RECEIPT,
];

describe('order messages', () => {
  it.each(MESSAGES)('round-trips a $type message', (message) => {
    expect(parseOrderMessage(buildOrderMessage(message, 1_000))).toEqual(message);
  });

  it('writes Gamma Markets tags', () => {
    const rumor = buildOrderMessage(ORDER, 1_000);
    expect(rumor.kind).toBe(KIND_ORDER_MESSAGE);
    expect(rumor.tags).toEqual([
      ['p', STORE],
      ['subject', 'order'],
      ['type', '1'],
      ['order', ORDER_ID],
      ['item', ITEM, '1'],
      ['amount', '49', 'USD'],
      ['email', 'buyer@example.com'],
    ]);
  });

  it('refuses to build a malformed message', () => {
    expect(() => buildOrderMessage({ ...ORDER, orderId: 'short' })).toThrow();
    expect(() => buildOrderMessage({ ...ORDER, items: [] })).toThrow();
    expect(() =>
      buildOrderMessage({ ...ORDER, total: { amount: '4.9e1', currency: 'USD' } }),
    ).toThrow();
    expect(() =>
      buildOrderMessage({ ...ORDER, items: [{ product: '30402:nothex:x', quantity: 1 }] }),
    ).toThrow();
    expect(() =>
      buildOrderMessage({ ...ORDER, items: [{ product: ITEM, quantity: 0 }] }),
    ).toThrow();
  });

  it('reads nothing from another kind, an unknown type, or a missing order id', () => {
    expect(parseOrderMessage({ kind: 14, tags: [['order', ORDER_ID]] })).toBeUndefined();
    expect(
      parseOrderMessage({
        kind: KIND_ORDER_MESSAGE,
        tags: [
          ['order', ORDER_ID],
          ['type', '9'],
        ],
      }),
    ).toBeUndefined();
    expect(parseOrderMessage({ kind: KIND_ORDER_MESSAGE, tags: [['type', '1']] })).toBeUndefined();
  });

  it('drops a receipt tag with a non-integer amount instead of guessing', () => {
    const parsed = parseOrderMessage({
      kind: KIND_ORDER_MESSAGE,
      tags: [
        ['p', BUYER],
        ['type', '3'],
        ['order', ORDER_ID],
        ['status', 'completed'],
        ['receipt', 'solana', 'sig', '49.5', '0'],
      ],
    });
    expect(parsed).toEqual({
      type: 'status',
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
      status: 'completed',
    });
  });
});

describe('gift wrap', () => {
  it('delivers a message the recipient can open, with the sender authenticated', () => {
    const buyer = nostrKey();
    const store = nostrKey();
    const message: OrderRequest = { ...ORDER, storePubkey: store.pubkey };
    const rumor = buildOrderMessage(message);
    const wrapped = wrapOrderMessage(rumor, buyer.secretKey, store.pubkey);

    expect(wrapped.recipientWrap.kind).toBe(KIND_GIFT_WRAP);
    // The wrap is signed by a throwaway key: relays do not learn who sent it.
    expect(wrapped.recipientWrap.pubkey).not.toBe(buyer.pubkey);
    expect(wrapped.recipientWrap.tags).toEqual([['p', store.pubkey]]);

    const opened = unwrapOrderMessage(wrapped.recipientWrap, store.secretKey);
    expect(opened?.senderPubkey).toBe(buyer.pubkey);
    expect(opened?.recipientPubkey).toBe(store.pubkey);
    expect(opened?.rumorId).toBe(wrapped.rumorId);
    expect(opened?.message).toEqual(message);

    const selfCopy = unwrapOrderMessage(wrapped.selfWrap, buyer.secretKey);
    expect(selfCopy?.rumorId).toBe(wrapped.rumorId);
  });

  it('opens nothing for a key it was not wrapped for', () => {
    const store = nostrKey();
    const wrapped = wrapOrderMessage(
      buildOrderMessage(RECEIPT),
      nostrKey().secretKey,
      store.pubkey,
    );
    expect(unwrapOrderMessage(wrapped.recipientWrap, nostrKey().secretKey)).toBeUndefined();
  });

  it('refuses a wrap whose outer signature was tampered with', () => {
    const store = nostrKey();
    const wrapped = wrapOrderMessage(
      buildOrderMessage(RECEIPT),
      nostrKey().secretKey,
      store.pubkey,
    );
    const tampered: NostrEvent = {
      ...wrapped.recipientWrap,
      created_at: wrapped.recipientWrap.created_at + 1,
    };
    expect(unwrapOrderMessage(tampered, store.secretKey)).toBeUndefined();
  });

  it('refuses a rumor that claims someone other than the seal signer', () => {
    // nostr-tools' own unwrapEvent would accept this and report the victim as sender.
    const attacker = generateSecretKey();
    const victim = getPublicKey(generateSecretKey());
    const store = nostrKey();
    const rumorBase = { ...buildOrderMessage(RECEIPT), pubkey: victim };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
    const seal = finalizeEvent(
      {
        kind: KIND_SEAL,
        created_at: rumor.created_at,
        tags: [],
        content: nip44.v2.encrypt(
          JSON.stringify(rumor),
          nip44.v2.utils.getConversationKey(attacker, store.pubkey),
        ),
      },
      attacker,
    );
    const wrap = nip59.createWrap(seal, store.pubkey);
    expect(nip59.unwrapEvent(wrap, store.secretKey).pubkey).toBe(victim);
    expect(unwrapOrderMessage(wrap, store.secretKey)).toBeUndefined();
  });

  it('refuses a seal whose signature does not verify', () => {
    const sender = generateSecretKey();
    const store = nostrKey();
    const rumor = nip59.createRumor(buildOrderMessage(RECEIPT), sender);
    const seal = nip59.createSeal(rumor, sender, store.pubkey);
    const forged = { ...seal, sig: seal.sig.replace(/^./, (char) => (char === '0' ? '1' : '0')) };
    const wrap = nip59.createWrap(forged, store.pubkey);
    expect(unwrapOrderMessage(wrap, store.secretKey)).toBeUndefined();
  });

  it('refuses to wrap a kind that is not an order message', () => {
    expect(() =>
      wrapOrderMessage(
        { kind: 14, created_at: 1, tags: [], content: '' },
        generateSecretKey(),
        STORE,
      ),
    ).toThrow();
  });
});
