import { describe, expect, it } from 'vitest';
import { intake } from '../src/intake';
import { T0, delivered, key, orderFrom, referenceFor, signatureOf, world } from './fixtures';

const TX1 = signatureOf(1);
const TX2 = signatureOf(2);

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-000000000001';

describe('intake of an order', () => {
  it('records a direct order under the seal signer, with the reference derived here', () => {
    const { store, identity, state } = world();
    const buyer = key();
    const result = intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    expect(result).toMatchObject({
      kind: 'order',
      order: {
        buyerPubkey: buyer.pubkey,
        orderId: ORDER_ID,
        reference: referenceFor(store, buyer, ORDER_ID),
        createdAt: T0 + 60,
        reportedTxs: [],
      },
    });
  });

  it('reads the same rumor once, and drops a different order under a used order id', () => {
    const { store, identity, state } = world();
    const buyer = key();
    const first = orderFrom(buyer, store, ORDER_ID);
    intake(state, first, identity);
    expect(intake(state, first, identity)).toEqual({ kind: 'ignored', reason: 'seen' });
    const again = delivered(
      {
        type: 'order',
        storePubkey: store.pubkey,
        orderId: ORDER_ID,
        items: [{ product: identity.productAddress, quantity: 1 }],
        total: { amount: '0.01', currency: 'USD' },
      },
      buyer,
      store,
    );
    expect(intake(state, again, identity)).toEqual({ kind: 'ignored', reason: 'order_id_reused' });
    expect(Object.values(state.orders)).toHaveLength(1);
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.rumorId).toBe(first.rumorId);
  });

  it('lets another buyer use the same order id: it is theirs, with its own reference', () => {
    const { store, identity, state } = world();
    intake(state, orderFrom(key(), store, ORDER_ID), identity);
    expect(intake(state, orderFrom(key(), store, ORDER_ID), identity)).toMatchObject({
      kind: 'order',
    });
  });

  it('takes only one item of its own product at quantity 1', () => {
    const { store, identity, state } = world();
    const buyer = key();
    const cases = [
      [{ product: `30402:${store.pubkey}:other`, quantity: 1 }],
      [{ product: identity.productAddress, quantity: 2 }],
      [
        { product: identity.productAddress, quantity: 1 },
        { product: identity.productAddress, quantity: 1 },
      ],
    ];
    cases.forEach((items, index) => {
      const message = delivered(
        {
          type: 'order',
          storePubkey: store.pubkey,
          orderId: `${ORDER_ID.slice(0, -1)}${index}`,
          items,
          total: { amount: '1', currency: 'USD' },
        },
        buyer,
        store,
      );
      expect(intake(state, message, identity)).toEqual({
        kind: 'ignored',
        reason: 'not_a_direct_order',
      });
    });
    expect(state.orders).toEqual({});
  });

  it('ignores an order dated before any payment could be', () => {
    const { store, identity, state } = world();
    const early = delivered(
      {
        type: 'order',
        storePubkey: store.pubkey,
        orderId: ORDER_ID,
        items: [{ product: identity.productAddress, quantity: 1 }],
        total: { amount: '1', currency: 'USD' },
      },
      key(),
      store,
      1_000_000,
    );
    expect(intake(state, early, identity)).toEqual({
      kind: 'ignored',
      reason: 'not_a_direct_order',
    });
  });

  it('ignores an order naming another store', () => {
    const { store, identity, state } = world();
    const other = key();
    const message = delivered(
      {
        type: 'order',
        storePubkey: other.pubkey,
        orderId: ORDER_ID,
        items: [{ product: identity.productAddress, quantity: 1 }],
        total: { amount: '1', currency: 'USD' },
      },
      key(),
      store,
    );
    expect(intake(state, message, identity)).toEqual({
      kind: 'ignored',
      reason: 'not_for_this_store',
    });
  });
});

describe('intake of a receipt', () => {
  function receipt(
    buyer: ReturnType<typeof key>,
    store: ReturnType<typeof key>,
    payment: { medium: string; reference: string; tx: string },
  ) {
    return delivered(
      { type: 'receipt', storePubkey: store.pubkey, orderId: ORDER_ID, payment },
      buyer,
      store,
    );
  }

  it('records the reported transaction of a known order', () => {
    const { store, identity, state } = world();
    const buyer = key();
    intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    const reference = referenceFor(store, buyer, ORDER_ID);
    const result = intake(
      state,
      receipt(buyer, store, { medium: 'solana-devnet', reference, tx: TX1 }),
      identity,
    );
    expect(result).toMatchObject({ kind: 'receipt', tx: TX1 });
    // A retry's receipt is a different rumor: it is read too.
    intake(state, receipt(buyer, store, { medium: 'solana-devnet', reference, tx: TX2 }), identity);
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.reportedTxs).toEqual([TX1, TX2]);
  });

  it('ignores a receipt for an order it does not hold, or of another buyer', () => {
    const { store, identity, state } = world();
    const buyer = key();
    const reference = referenceFor(store, buyer, ORDER_ID);
    const early = receipt(buyer, store, { medium: 'solana-devnet', reference, tx: TX1 });
    expect(intake(state, early, identity)).toEqual({ kind: 'ignored', reason: 'unknown_order' });
    intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    // Arriving before its order, it is read again once the order is in.
    expect(intake(state, early, identity)).toMatchObject({ kind: 'receipt' });
    const stranger = key();
    expect(
      intake(
        state,
        receipt(stranger, store, { medium: 'solana-devnet', reference, tx: TX1 }),
        identity,
      ),
    ).toEqual({ kind: 'ignored', reason: 'unknown_order' });
  });

  it('ignores a receipt under another reference or on a rail the store does not take', () => {
    const { store, identity, state } = world();
    const buyer = key();
    intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    const reference = referenceFor(store, buyer, ORDER_ID);
    const wrongReference = referenceFor(store, key(), ORDER_ID);
    for (const payment of [
      { medium: 'solana-devnet', reference: wrongReference, tx: TX1 },
      { medium: 'solana', reference, tx: TX1 },
      // Well-formed for the protocol, but not a Solana signature (a Tempo hash).
      { medium: 'solana-devnet', reference, tx: `0x${'ab'.repeat(32)}` },
    ]) {
      expect(intake(state, receipt(buyer, store, payment), identity)).toEqual({
        kind: 'ignored',
        reason: 'foreign_payment',
      });
    }
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.reportedTxs).toEqual([]);
  });

  it('keeps a bounded number of receipts per order', () => {
    const { store, identity, state } = world();
    const buyer = key();
    intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    const reference = referenceFor(store, buyer, ORDER_ID);
    for (let fill = 10; fill < 15; fill += 1) {
      intake(
        state,
        receipt(buyer, store, { medium: 'solana-devnet', reference, tx: signatureOf(fill) }),
        identity,
      );
    }
    const sixth = receipt(buyer, store, {
      medium: 'solana-devnet',
      reference,
      tx: signatureOf(20),
    });
    expect(intake(state, sixth, identity)).toEqual({
      kind: 'ignored',
      reason: 'too_many_receipts',
    });
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.reportedTxs).toHaveLength(5);
  });

  it('reads a republished receipt once, and a receipt naming another store never', () => {
    const { store, identity, state } = world();
    const buyer = key();
    intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    const reference = referenceFor(store, buyer, ORDER_ID);
    const sent = receipt(buyer, store, { medium: 'solana-devnet', reference, tx: TX1 });
    intake(state, sent, identity);
    expect(intake(state, sent, identity)).toEqual({ kind: 'ignored', reason: 'seen' });
    const other = key();
    const misaddressed = delivered(
      {
        type: 'receipt',
        storePubkey: other.pubkey,
        orderId: ORDER_ID,
        payment: { medium: 'solana-devnet', reference, tx: TX2 },
      },
      buyer,
      store,
    );
    expect(intake(state, misaddressed, identity)).toEqual({
      kind: 'ignored',
      reason: 'not_for_this_store',
    });
  });

  it('still reads a receipt re-reporting a kept transaction at the cap', () => {
    const { store, identity, state } = world();
    const buyer = key();
    intake(state, orderFrom(buyer, store, ORDER_ID), identity);
    const reference = referenceFor(store, buyer, ORDER_ID);
    for (let fill = 10; fill < 15; fill += 1) {
      intake(
        state,
        receipt(buyer, store, { medium: 'solana-devnet', reference, tx: signatureOf(fill) }),
        identity,
      );
    }
    const repeat = delivered(
      {
        type: 'receipt',
        storePubkey: store.pubkey,
        orderId: ORDER_ID,
        payment: { medium: 'solana-devnet', reference, tx: signatureOf(10) },
      },
      buyer,
      store,
      T0 + 999,
    );
    expect(intake(state, repeat, identity)).toMatchObject({ kind: 'receipt' });
    expect(state.orders[`${buyer.pubkey}:${ORDER_ID}`]?.reportedTxs).toHaveLength(5);
  });
});
