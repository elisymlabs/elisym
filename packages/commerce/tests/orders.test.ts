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
  isCustomerRef,
  parseOrderMessage,
} from '../src/orders/messages';
import { nostrKey } from './fixtures';

const STORE = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const ORDER_ID = '8f14e45f-ceea-467a-9575-1b2c3d4e5f60';
const ITEM = `30402:${STORE}:course-101`;
const USDC_ASSET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

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
  {
    type: 'status',
    buyerPubkey: BUYER,
    orderId: ORDER_ID,
    status: 'completed',
    delivery: { method: 'access', value: 'https://shop.example/course?token=t' },
    receipt: { medium: 'solana', tx: '5xSig', amount: '49000000', fee: '0', caip19: USDC_ASSET },
  },
  {
    type: 'status',
    buyerPubkey: BUYER,
    orderId: ORDER_ID,
    status: 'cancelled',
    refund: { tx: '4xRefund', amount: '49000000', caip19: USDC_ASSET },
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
    // A plain-JS caller is not held back by the types: the builder checks what the parser checks.
    expect(() =>
      buildOrderMessage(JSON.parse(JSON.stringify({ type: 'bogus', orderId: ORDER_ID }))),
    ).toThrow(/Unknown order message type/);
    const status = { type: 'status', buyerPubkey: BUYER, orderId: ORDER_ID };
    expect(() =>
      buildOrderMessage(JSON.parse(JSON.stringify({ ...status, status: 'shipped' }))),
    ).toThrow();
    expect(() =>
      buildOrderMessage(
        JSON.parse(
          JSON.stringify({
            ...status,
            status: 'completed',
            delivery: { method: 'fax', value: 'x' },
          }),
        ),
      ),
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

  it('carries the credited asset as the last element of the receipt and refund tags', () => {
    const credited = buildOrderMessage({
      type: 'status',
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
      status: 'completed',
      receipt: { medium: 'solana', tx: '5xSig', amount: '1', fee: '0', caip19: USDC_ASSET },
    });
    expect(credited.tags).toContainEqual(['receipt', 'solana', '5xSig', '1', '0', USDC_ASSET]);
    const refunded = buildOrderMessage({
      type: 'status',
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
      status: 'cancelled',
      refund: { tx: '4xRefund', amount: '1', caip19: USDC_ASSET },
    });
    expect(refunded.tags).toContainEqual(['refund', '4xRefund', '1', USDC_ASSET]);
    for (const asset of ['', 'not an asset', 'solana/token', `${USDC_ASSET} `]) {
      expect(() =>
        buildOrderMessage({
          type: 'status',
          buyerPubkey: BUYER,
          orderId: ORDER_ID,
          status: 'completed',
          receipt: { medium: 'solana', tx: '5xSig', amount: '1', fee: '0', caip19: asset },
        }),
      ).toThrow(/receipt asset/);
      expect(() =>
        buildOrderMessage({
          type: 'status',
          buyerPubkey: BUYER,
          orderId: ORDER_ID,
          status: 'cancelled',
          refund: { tx: '4xRefund', amount: '1', caip19: asset },
        }),
      ).toThrow(/refund asset/);
    }
  });

  it('keeps a receipt and a refund whose asset is unreadable, without the asset', () => {
    const parsed = parseOrderMessage({
      kind: KIND_ORDER_MESSAGE,
      tags: [
        ['p', BUYER],
        ['type', '3'],
        ['order', ORDER_ID],
        ['status', 'cancelled'],
        ['receipt', 'solana', 'sig', '49', '0', 'garbage asset'],
        ['refund', 'refundTx', '49', 'garbage asset'],
      ],
    });
    expect(parsed).toEqual({
      type: 'status',
      buyerPubkey: BUYER,
      orderId: ORDER_ID,
      status: 'cancelled',
      receipt: { medium: 'solana', tx: 'sig', amount: '49', fee: '0' },
      refund: { tx: 'refundTx', amount: '49' },
    });
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

  it('drops a payment option whose payload is longer than a builder may write', () => {
    const longest = 'p'.repeat(4096);
    const paymentRequest = (payload: string) => ({
      kind: KIND_ORDER_MESSAGE,
      tags: [
        ['p', BUYER],
        ['type', '2'],
        ['order', ORDER_ID],
        ['amount', '49', 'USD'],
        ['payment', 'elisym-v2', payload],
      ],
    });
    expect(parseOrderMessage(paymentRequest(longest))).toMatchObject({
      options: [{ medium: 'elisym-v2', payload: longest }],
    });
    expect(parseOrderMessage(paymentRequest(`${longest}p`))).toBeUndefined();
  });
});

const INVALID_CUSTOMER_REFS = [
  '',
  'x'.repeat(129),
  'user 123',
  'user\n123',
  '<script>',
  'user"123',
  "user'123",
  'usér',
  '../etc',
  'user/123',
  '{"id":1}',
];

describe('customer_ref', () => {
  const VALID_REF = 'user-123_a.b:c@shop';

  it('round-trips a reference as the last order tag', () => {
    const order: OrderRequest = { ...ORDER, customerRef: VALID_REF };
    const rumor = buildOrderMessage(order, 1_000);
    expect(rumor.tags.at(-1)).toEqual(['customer_ref', VALID_REF]);
    expect(parseOrderMessage(rumor)).toEqual(order);
    const longest = { ...ORDER, customerRef: 'x'.repeat(128) };
    expect(parseOrderMessage(buildOrderMessage(longest, 1_000))).toEqual(longest);
  });

  it('writes no tag and reads no reference when there is none', () => {
    const rumor = buildOrderMessage(ORDER, 1_000);
    expect(rumor.tags.some((tag) => tag[0] === 'customer_ref')).toBe(false);
    expect(parseOrderMessage(rumor)).not.toHaveProperty('customerRef');
  });

  it.each(INVALID_CUSTOMER_REFS)('refuses to build, and drops on read, %j', (customerRef) => {
    expect(isCustomerRef(customerRef)).toBe(false);
    expect(() => buildOrderMessage({ ...ORDER, customerRef })).toThrow(/customer_ref/);
    const rumor = buildOrderMessage(ORDER, 1_000);
    const parsed = parseOrderMessage({
      kind: rumor.kind,
      tags: [...rumor.tags, ['customer_ref', customerRef]],
    });
    // The order stays valid; only the reference is dropped.
    expect(parsed).toEqual(ORDER);
  });

  it('reads the first of duplicate tags only, and nothing from a non-string', () => {
    const rumor = buildOrderMessage({ ...ORDER, customerRef: 'first' }, 1_000);
    const doubled = { kind: rumor.kind, tags: [...rumor.tags, ['customer_ref', 'second']] };
    expect(parseOrderMessage(doubled)).toMatchObject({ customerRef: 'first' });
    const badFirst = {
      kind: rumor.kind,
      tags: [
        ...buildOrderMessage(ORDER, 1_000).tags,
        ['customer_ref', 'bad ref'],
        ['customer_ref', 'second'],
      ],
    };
    expect(parseOrderMessage(badFirst)).toEqual(ORDER);
    expect(isCustomerRef(123)).toBe(false);
    expect(isCustomerRef(undefined)).toBe(false);
    expect(isCustomerRef(VALID_REF)).toBe(true);
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

  it('refuses a wrap whose fields or outer signature were tampered with', () => {
    const store = nostrKey();
    const wrapped = wrapOrderMessage(
      buildOrderMessage(RECEIPT),
      nostrKey().secretKey,
      store.pubkey,
    );
    const redated: NostrEvent = {
      ...wrapped.recipientWrap,
      created_at: wrapped.recipientWrap.created_at + 1,
    };
    const resigned: NostrEvent = {
      ...wrapped.recipientWrap,
      sig: wrapped.recipientWrap.sig.replace(/^./, (char) => (char === '0' ? '1' : '0')),
    };
    expect(unwrapOrderMessage(redated, store.secretKey)).toBeUndefined();
    expect(unwrapOrderMessage(resigned, store.secretKey)).toBeUndefined();
  });

  it('refuses a seal with tags and a rumor that carries a signature (NIP-59)', () => {
    const sender = generateSecretKey();
    const store = nostrKey();
    const sealOf = (rumor: object, tags: string[][]): NostrEvent =>
      finalizeEvent(
        {
          kind: KIND_SEAL,
          created_at: 1_750_000_000,
          tags,
          content: nip44.v2.encrypt(
            JSON.stringify(rumor),
            nip44.v2.utils.getConversationKey(sender, store.pubkey),
          ),
        },
        sender,
      );
    const rumor = nip59.createRumor(buildOrderMessage(RECEIPT), sender);
    expect(
      unwrapOrderMessage(nip59.createWrap(sealOf(rumor, []), store.pubkey), store.secretKey),
    ).toBeDefined();
    expect(
      unwrapOrderMessage(
        nip59.createWrap(sealOf(rumor, [['p', store.pubkey]]), store.pubkey),
        store.secretKey,
      ),
    ).toBeUndefined();
    const signedRumor = { ...rumor, sig: 'f'.repeat(128) };
    expect(
      unwrapOrderMessage(nip59.createWrap(sealOf(signedRumor, []), store.pubkey), store.secretKey),
    ).toBeUndefined();
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
