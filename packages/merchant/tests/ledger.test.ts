import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type MerchantOrder,
  claimPayment,
  emptyLedger,
  loadLedger,
  openOrders,
  saveLedger,
  undeliveredOrders,
} from '../src/ledger';

function order(
  key: string,
  createdAt: number,
  overrides: Partial<MerchantOrder> = {},
): MerchantOrder {
  return {
    key,
    buyerPubkey: 'b'.repeat(64),
    orderId: key,
    rumorId: key,
    createdAt,
    reference: 'Ref',
    reportedTxs: [],
    ...overrides,
  };
}

const PAID = { signature: 'S', amount: '1', blockTime: 1, caip19: 'x', medium: 'solana-devnet' };

describe('ledger', () => {
  it('claims a payment for one order only', () => {
    const state = emptyLedger();
    expect(claimPayment(state, 'S', 'a')).toBe(true);
    expect(claimPayment(state, 'S', 'a')).toBe(true);
    expect(claimPayment(state, 'S', 'b')).toBe(false);
    expect(state.claims).toEqual({ S: 'a' });
  });

  it('keeps an order open until it is paid or leaves the catch-up window', () => {
    const state = emptyLedger();
    state.orders = {
      fresh: order('fresh', 1000),
      old: order('old', 1000 - 500),
      paid: order('paid', 1000, { paid: PAID }),
    };
    expect(openOrders(state, 1100, 300).map((entry) => entry.key)).toEqual(['fresh']);
  });

  it('lists paid orders not yet delivered', () => {
    const state = emptyLedger();
    state.orders = {
      waiting: order('waiting', 1, { paid: PAID }),
      done: order('done', 1, { paid: PAID, deliveredAt: 2 }),
      unpaid: order('unpaid', 1),
    };
    expect(undeliveredOrders(state).map((entry) => entry.key)).toEqual(['waiting']);
  });

  it('saves and loads the whole state, and starts empty without a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-ledger-'));
    const path = join(directory, 'ledger.json');
    expect(loadLedger(path)).toEqual(emptyLedger());
    const state = emptyLedger();
    state.orders.a = order('a', 5);
    claimPayment(state, 'S', 'a');
    saveLedger(path, state);
    expect(loadLedger(path)).toEqual(state);
    expect(() => readFileSync(`${path}.tmp`)).toThrow();
  });
});
