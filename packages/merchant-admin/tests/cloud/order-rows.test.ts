import { describe, expect, it } from 'vitest';
import { orderRowOf, orderRowsOf } from '../../src/cloud/lib/order-rows';
import type { OrderPaymentRead, OrderRead } from '../../src/cloud/lib/orders';
import {
  creditedCoins,
  orderSlices,
  unchartedCredits,
  unconfirmedPayments,
} from '../../src/lib/charts';
import { totalsOf } from '../../src/lib/core';

const USDC =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const UNKNOWN = 'solana:nowhere/token:nothing';

function payment(overrides: Partial<OrderPaymentRead> = {}): OrderPaymentRead {
  return {
    signature: 'sig1',
    amount: '1500000',
    fee: '5000',
    asset: USDC,
    medium: 'solana',
    paidAt: 210,
    ...overrides,
  };
}

function order(overrides: Partial<OrderRead> = {}): OrderRead {
  return {
    key: 'buyer1:o1',
    buyer: 'buyer1',
    orderId: 'o1',
    createdAt: 200,
    product: '30402:store:course',
    email: null,
    customerRef: null,
    payment: null,
    deliveredAt: null,
    webhook: null,
    feeUnresolved: [],
    blockedTx: null,
    ...overrides,
  };
}

describe('cloud orders as admin rows', () => {
  it('makes a paid, completed order delivered with its one credit', () => {
    const row = orderRowOf(order({ payment: payment(), deliveredAt: 212 }));
    expect(row).toMatchObject({
      key: 'buyer1:o1',
      buyerPubkey: 'buyer1',
      orderId: 'o1',
      createdAt: 200,
      product: '30402:store:course',
      state: 'delivered',
      conflict: false,
      orderNotLoaded: false,
      refunds: [],
      reported: [],
      unlistedMedium: false,
    });
    expect(row.credits).toHaveLength(1);
    expect(row.credits[0]).toMatchObject({
      tx: 'sig1',
      amount: '1500000',
      fee: '5000',
      medium: 'solana',
    });
    expect(row.credits[0]?.asset?.id).toBe(USDC);
    expect(row.credits[0]?.explorer).toMatch(/^https:\/\/.*sig1/);
  });

  it('keeps a completed order delivered when only its webhook failed', () => {
    const row = orderRowOf(
      order({
        payment: payment(),
        deliveredAt: 212,
        webhook: { state: 'failed', attempts: 3, lastStatus: 500, lastError: 'took 3 tries' },
      }),
    );
    expect(row.state).toBe('delivered');
    expect(row.credits).toHaveLength(1);
  });

  it('reads a paid order whose completion is not out as payment reported, never completed', () => {
    const row = orderRowOf(order({ payment: payment(), deliveredAt: null }));
    expect(row.state).toBe('payment_reported');
    // The money arrived: it is credited.
    expect(row.credits).toHaveLength(1);
    expect(totalsOf([row]).perAsset).toEqual([expect.objectContaining({ subunits: '1495000' })]);
    // The store confirmed it: the status card warns of nothing.
    expect(unconfirmedPayments([row])).toBe(0);
    expect(unconfirmedPayments([{ ...row, credits: [] }])).toBe(1);
  });

  it('makes an unpaid order ordered, with no credit', () => {
    const row = orderRowOf(order({ blockedTx: 'tx3', feeUnresolved: ['tx2'] }));
    expect(row.state).toBe('ordered');
    expect(row.credits).toEqual([]);
  });

  it('counts the unpaid order in the charts, but credits nothing for it', () => {
    const rows = orderRowsOf([order({ key: 'b:paid', payment: payment() }), order({ key: 'b:x' })]);
    const coins = creditedCoins(rows);
    expect(orderSlices(rows, coins).map((slice) => [slice.key, slice.count])).toEqual([
      [USDC, 1],
      ['unpaid', 1],
    ]);
    expect(totalsOf(rows).perAsset).toEqual([
      expect.objectContaining({ subunits: '1495000', amount: '1.495' }),
    ]);
  });

  it('nets the fee out of the totals, and takes a zero fee as is', () => {
    const rows = orderRowsOf([
      order({ key: 'b:1', payment: payment({ signature: 's1', fee: '0' }) }),
      order({ key: 'b:2', payment: payment({ signature: 's2', fee: '500000' }) }),
    ]);
    expect(totalsOf(rows).perAsset).toEqual([
      expect.objectContaining({ subunits: '2500000', amount: '2.5' }),
    ]);
  });

  it('keeps a payment in an unknown asset out of the chart, counted as uncharted', () => {
    const rows = orderRowsOf([
      order({ payment: payment({ asset: UNKNOWN, medium: 'solana', fee: '0' }) }),
    ]);
    const credit = rows[0]?.credits[0];
    expect(credit?.asset).toBeUndefined();
    expect(credit?.explorer).toBeUndefined();
    expect(creditedCoins(rows)).toEqual([]);
    expect(unchartedCredits(rows)).toBe(1);
    expect(totalsOf(rows).unknownAsset).toEqual([{ medium: 'solana', subunits: '1500000' }]);
  });

  it('keeps the rail the payment came on: totals of an unknown asset are per medium', () => {
    const rows = orderRowsOf([
      order({
        key: 'b:1',
        payment: payment({ signature: 't1', asset: UNKNOWN, medium: 'tempo', fee: '0' }),
      }),
      order({ key: 'b:2', payment: payment({ signature: 's1', asset: UNKNOWN, fee: '0' }) }),
    ]);
    expect(rows.map((row) => row.credits[0]?.medium)).toEqual(['tempo', 'solana']);
    expect(totalsOf(rows).unknownAsset).toEqual(
      expect.arrayContaining([
        { medium: 'tempo', subunits: '1500000' },
        { medium: 'solana', subunits: '1500000' },
      ]),
    );
  });

  it('maps every order and nothing else, in order', () => {
    const rows = orderRowsOf([
      order({ key: 'b:1' }),
      order({ key: 'b:2', payment: payment(), deliveredAt: 212 }),
    ]);
    expect(rows.map((row) => [row.key, row.state])).toEqual([
      ['b:1', 'ordered'],
      ['b:2', 'delivered'],
    ]);
  });
});
