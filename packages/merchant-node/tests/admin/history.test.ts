import { MAX_FUTURE_SKEW_SECS } from '@elisym/commerce';
import { getBase58Decoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buildHistory, claimCheck } from '../../src/admin/history';
import {
  EARLIEST_ORDER_SECS,
  MAX_RECEIPTS_PER_ORDER,
  TERMS_WINDOW_SECS,
} from '../../src/constants';
import {
  T0,
  TX1,
  TX2,
  USDC_DEVNET_CAIP19,
  adminStore,
  deliveredBody,
  key,
  message,
  orderBody,
  productOf,
  receiptBody,
} from './fixtures';

const ORDER_ID = 'b3a7c2d4-0000-4000-8000-000000000001';

describe('who is believed', () => {
  it('ignores a status the store key did not seal, however it is dressed', () => {
    const store = key();
    const buyer = key();
    const forger = key();
    const history = buildHistory(
      [
        message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey),
        message(
          deliveredBody(buyer, ORDER_ID, { caip19: USDC_DEVNET_CAIP19 }),
          forger.pubkey,
          store.pubkey,
        ),
        message(deliveredBody(buyer, ORDER_ID), buyer.pubkey, store.pubkey),
      ],
      adminStore(store),
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]?.state).toBe('ordered');
    expect(history.rows[0]?.credits).toEqual([]);
    expect(history.totals).toEqual({ perAsset: [], unknownAsset: [] });
  });

  it("takes a status the store key sealed as the node's word, filed under the buyer it names", () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey),
        message(
          deliveredBody(buyer, ORDER_ID, { caip19: USDC_DEVNET_CAIP19 }),
          store.pubkey,
          buyer.pubkey,
        ),
      ],
      adminStore(store),
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ state: 'delivered', orderNotLoaded: false });
  });

  it('ignores an order or a receipt the store key sealed', () => {
    const store = key();
    const history = buildHistory(
      [
        message(orderBody(store, ORDER_ID), store.pubkey, store.pubkey),
        message(receiptBody(store, store, ORDER_ID), store.pubkey, store.pubkey),
      ],
      adminStore(store),
    );
    expect(history.rows).toEqual([]);
  });

  it('ignores buyer messages addressed to or naming another store', () => {
    const store = key();
    const other = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(orderBody(store, ORDER_ID), buyer.pubkey, other.pubkey),
        message(orderBody(other, 'order-0002'), buyer.pubkey, store.pubkey),
        message(receiptBody(store, buyer, 'order-0003'), buyer.pubkey, other.pubkey),
        // This store's product, but an order placed with another store.
        message(
          orderBody(store, 'order-0004', { storePubkey: other.pubkey }),
          buyer.pubkey,
          store.pubkey,
        ),
      ],
      adminStore(store),
    );
    expect(history.rows).toEqual([]);
  });
});

describe('which orders count', () => {
  it('drops spam: unknown products, wildcards, quantities, several items, impossible dates', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(
          orderBody(store, 'order-junk', {
            items: [{ product: productOf(store, 'junk'), quantity: 1 }],
          }),
          buyer.pubkey,
          store.pubkey,
        ),
        message(
          orderBody(store, 'order-two', { items: [{ product: productOf(store), quantity: 2 }] }),
          buyer.pubkey,
          store.pubkey,
        ),
        message(
          orderBody(store, 'order-many', {
            items: [
              { product: productOf(store), quantity: 1 },
              { product: productOf(store), quantity: 1 },
            ],
          }),
          buyer.pubkey,
          store.pubkey,
        ),
        message(orderBody(store, 'order-old'), buyer.pubkey, store.pubkey, EARLIEST_ORDER_SECS - 1),
      ],
      adminStore(store),
    );
    expect(history.rows).toEqual([]);
  });

  it('takes an order for any listing the store published', () => {
    const store = key();
    const buyer = key();
    const second = productOf(store, 'second');
    const history = buildHistory(
      [
        message(
          orderBody(store, ORDER_ID, { items: [{ product: second, quantity: 1 }] }),
          buyer.pubkey,
          store.pubkey,
        ),
      ],
      adminStore(store, { productAddresses: new Set([productOf(store), second]) }),
    );
    expect(history.rows.map((row) => row.state)).toEqual(['ordered']);
  });

  it('shows two different orders under one id as a conflict, and one resent order once', () => {
    const store = key();
    const buyer = key();
    const resent = message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey);
    const once = buildHistory([resent, resent], adminStore(store));
    expect(once.rows[0]).toMatchObject({ conflict: false, order: { orderId: ORDER_ID } });
    const conflicting = buildHistory(
      [resent, message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey, T0 + 90)],
      adminStore(store),
    );
    expect(conflicting.rows).toHaveLength(1);
    expect(conflicting.rows[0]?.conflict).toBe(true);
    expect(conflicting.rows[0]?.order).toBeUndefined();
  });
});

describe('receipts', () => {
  it('reports a receipt under the derived reference, at most the node cap', () => {
    const store = key();
    const buyer = key();
    const receipts = Array.from({ length: MAX_RECEIPTS_PER_ORDER + 1 }, (_, index) => {
      const tx = getBase58Decoder().decode(new Uint8Array(64).fill(index + 1));
      return message(receiptBody(store, buyer, ORDER_ID, tx), buyer.pubkey, store.pubkey);
    });
    const history = buildHistory(
      [message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey), ...receipts],
      adminStore(store),
    );
    expect(history.rows[0]?.state).toBe('payment_reported');
    expect(history.rows[0]?.reported).toHaveLength(MAX_RECEIPTS_PER_ORDER);
  });

  it('drops a receipt under another reference or with a malformed tx', () => {
    const store = key();
    const buyer = key();
    const other = key();
    const badTx = receiptBody(store, buyer, ORDER_ID, 'not-a-signature');
    const history = buildHistory(
      [
        message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey),
        message(receiptBody(store, other, ORDER_ID), buyer.pubkey, store.pubkey),
        message(badTx, buyer.pubkey, store.pubkey),
      ],
      adminStore(store),
    );
    expect(history.rows[0]).toMatchObject({
      state: 'ordered',
      reported: [],
      unlistedMedium: false,
    });
  });

  it('marks a receipt in a medium the store does not list, and does not report it', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey),
        message(receiptBody(store, buyer, ORDER_ID), buyer.pubkey, store.pubkey),
      ],
      adminStore(store, { mediums: ['solana'] }),
    );
    expect(history.rows[0]).toMatchObject({ state: 'ordered', unlistedMedium: true });
  });

  it('makes no row from a receipt alone in a medium the store does not list', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [message(receiptBody(store, buyer, ORDER_ID), buyer.pubkey, store.pubkey)],
      adminStore(store, { mediums: ['solana'] }),
    );
    expect(history.rows).toEqual([]);
  });

  it('shows a receipt whose order is not loaded as such', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [message(receiptBody(store, buyer, ORDER_ID), buyer.pubkey, store.pubkey)],
      adminStore(store),
    );
    expect(history.rows[0]).toMatchObject({ state: 'payment_reported', orderNotLoaded: true });
  });
});

describe('node statuses and totals', () => {
  it('counts a delivery resent many times once', () => {
    const store = key();
    const buyer = key();
    const resends = [0, 600, 1200].map((offset) =>
      message(
        deliveredBody(buyer, ORDER_ID, { caip19: USDC_DEVNET_CAIP19 }),
        store.pubkey,
        buyer.pubkey,
        T0 + 120 + offset,
      ),
    );
    const history = buildHistory(
      [message(orderBody(store, ORDER_ID), buyer.pubkey, store.pubkey), ...resends],
      adminStore(store),
    );
    expect(history.rows[0]?.credits).toHaveLength(1);
    expect(history.totals.perAsset).toEqual([
      expect.objectContaining({ subunits: '1000000', amount: '1' }),
    ]);
  });

  it('names the asset from the CAIP-19 id, with an explorer link on its chain', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(
          deliveredBody(buyer, ORDER_ID, { caip19: USDC_DEVNET_CAIP19, amount: '1500000' }),
          store.pubkey,
          buyer.pubkey,
        ),
      ],
      adminStore(store),
    );
    const credit = history.rows[0]?.credits[0];
    expect(credit?.asset?.asset.symbol).toBe('USDC');
    expect(credit?.explorer).toBe(`https://explorer.solana.com/tx/${TX1}?cluster=devnet`);
    expect(history.rows[0]?.orderNotLoaded).toBe(true);
    expect(history.totals.perAsset[0]).toMatchObject({ amount: '1.5', subunits: '1500000' });
  });

  it('keeps an amount without a known asset out of the asset totals, per medium', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(deliveredBody(buyer, ORDER_ID, { amount: '7' }), store.pubkey, buyer.pubkey),
        message(
          deliveredBody(buyer, 'order-0002', { amount: '5', tx: TX2, caip19: 'solana:x/token:y' }),
          store.pubkey,
          buyer.pubkey,
        ),
      ],
      adminStore(store),
    );
    expect(history.totals.perAsset).toEqual([]);
    expect(history.totals.unknownAsset).toEqual([{ medium: 'solana-devnet', subunits: '12' }]);
    expect(history.rows.every((row) => row.credits[0]?.explorer === undefined)).toBe(true);
  });

  it('counts one transaction once, whichever orders name it', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      ['order-0001', 'order-0002'].map((orderId) =>
        message(
          deliveredBody(buyer, orderId, { caip19: USDC_DEVNET_CAIP19 }),
          store.pubkey,
          buyer.pubkey,
        ),
      ),
      adminStore(store),
    );
    expect(history.rows).toHaveLength(2);
    expect(history.totals.perAsset[0]?.subunits).toBe('1000000');
  });

  it('sums past 2^53 exactly', () => {
    const store = key();
    const buyer = key();
    const big = '9007199254740993';
    const history = buildHistory(
      [TX1, TX2].map((tx, index) =>
        message(
          deliveredBody(buyer, `order-000${index}`, {
            tx,
            amount: big,
            caip19: USDC_DEVNET_CAIP19,
          }),
          store.pubkey,
          buyer.pubkey,
        ),
      ),
      adminStore(store),
    );
    expect(history.totals.perAsset[0]).toMatchObject({
      subunits: '18014398509481986',
      amount: '18014398509.481986',
    });
  });

  it('tells released by hand and refunded apart, and counts neither', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(
          {
            type: 'status',
            buyerPubkey: buyer.pubkey,
            orderId: 'order-released',
            status: 'completed',
          },
          store.pubkey,
          buyer.pubkey,
        ),
        message(
          {
            type: 'status',
            buyerPubkey: buyer.pubkey,
            orderId: 'order-refunded',
            status: 'cancelled',
            refund: { tx: TX2, amount: '250000', caip19: USDC_DEVNET_CAIP19 },
          },
          store.pubkey,
          buyer.pubkey,
        ),
        message(
          {
            type: 'status',
            buyerPubkey: buyer.pubkey,
            orderId: 'order-refunded-raw',
            status: 'cancelled',
            refund: { tx: TX1, amount: '3' },
          },
          store.pubkey,
          buyer.pubkey,
        ),
      ],
      adminStore(store),
    );
    const byId = new Map(history.rows.map((row) => [row.orderId, row]));
    expect(byId.get('order-released')?.state).toBe('released');
    expect(byId.get('order-refunded')?.state).toBe('refunded');
    expect(byId.get('order-refunded')?.refunds[0]?.asset?.asset.symbol).toBe('USDC');
    expect(byId.get('order-refunded-raw')?.refunds[0]?.asset).toBeUndefined();
    expect(history.totals).toEqual({ perAsset: [], unknownAsset: [] });
  });
});

describe('the claimed total', () => {
  const listing = { price: { amount: '49', currency: 'USD' }, createdAt: T0 };
  const settled = T0 + TERMS_WINDOW_SECS + MAX_FUTURE_SKEW_SECS;

  it('compares as decimals in the same currency once the listing settled', () => {
    expect(claimCheck({ amount: '49.00', currency: 'USD' }, settled, listing)).toBe('matches');
    expect(claimCheck({ amount: '49.01', currency: 'USD' }, settled, listing)).toBe('differs');
    expect(claimCheck({ amount: '49', currency: 'EUR' }, settled, listing)).toBe('differs');
  });

  it('never judges an order placed around a reprice', () => {
    const repriced = { price: { amount: '59', currency: 'USD' }, createdAt: T0 };
    expect(claimCheck({ amount: '49', currency: 'USD' }, T0 + 5 * 60, repriced)).toBe(
      'not_checked',
    );
    expect(claimCheck({ amount: '49', currency: 'USD' }, settled - 1, repriced)).toBe(
      'not_checked',
    );
    expect(claimCheck({ amount: '49', currency: 'USD' }, settled, repriced)).toBe('differs');
    expect(claimCheck({ amount: '49', currency: 'USD' }, settled, undefined)).toBe('not_checked');
  });

  it('is carried on the row of a settled order', () => {
    const store = key();
    const buyer = key();
    const history = buildHistory(
      [
        message(
          orderBody(store, ORDER_ID, { total: { amount: '1.00', currency: 'USD' } }),
          buyer.pubkey,
          store.pubkey,
          settled,
        ),
      ],
      adminStore(store),
    );
    expect(history.rows[0]?.claimCheck).toBe('matches');
  });
});
