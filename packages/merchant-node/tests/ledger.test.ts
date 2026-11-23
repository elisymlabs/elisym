import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  upgradeLedger,
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
    product: `30402:${'s'.repeat(64)}:d`,
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
    expect(loadLedger(path)).toEqual({ state: emptyLedger(), read: 'missing' });
    const state = emptyLedger();
    state.orders.a = order('a', 5);
    claimPayment(state, 'S', 'a');
    saveLedger(path, state);
    expect(loadLedger(path)).toEqual({ state, read: 5 });
    expect(() => readFileSync(`${path}.tmp`)).toThrow();
  });

  it('refuses to start empty when the ledger exists but cannot be read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-ledger-'));
    // A directory where the file should be: a read error that is not "missing".
    expect(() => loadLedger(directory)).toThrow(/EISDIR/);
  });
});

/** A ledger as an older node saved it: version `version`, without the fields added since. */
function olderLedger(version: number, dropped: readonly string[]): Record<string, unknown> {
  const state: Record<string, unknown> = { ...emptyLedger() };
  state.orders = { a: order('a', 5) };
  for (const field of dropped) {
    delete state[field];
  }
  return { ...state, version };
}

describe('upgrading a ledger read from anywhere', () => {
  it('converts a ledger from before fee support (v3) and says it held v3', () => {
    const raw = olderLedger(3, [
      'treasuries',
      'unresolvedPayments',
      'eip3009Bindings',
      'scans',
      'listings',
    ]);
    const { state, read } = upgradeLedger(raw, 'row a');
    expect(read).toBe(3);
    expect(state).toEqual({ ...emptyLedger(), orders: { a: order('a', 5) } });
  });

  it('converts a ledger from before marked memos (v4), keeping what it holds', () => {
    const raw = olderLedger(4, ['eip3009Bindings']);
    raw.treasuries = { devnet: { readAt: 1 } };
    const { state, read } = upgradeLedger(raw, 'row a');
    expect(read).toBe(4);
    expect(state.version).toBe(5);
    expect(state.treasuries).toEqual({ devnet: { readAt: 1 } });
    expect(state.eip3009Bindings).toEqual({});
  });

  it('takes a v5 ledger as it is', () => {
    const saved = { ...emptyLedger(), orders: { a: order('a', 5) } };
    const raw: unknown = JSON.parse(JSON.stringify(saved));
    expect(upgradeLedger(raw, 'row a')).toEqual({ state: saved, read: 5 });
  });

  it('refuses a ledger from 0.7, an unknown version and a value that is no ledger, naming where', () => {
    expect(() => upgradeLedger({ version: 2 }, 'row a')).toThrow(/^row a: /);
    expect(() => upgradeLedger({ version: 6 }, 'row a')).toThrow('Unknown ledger version in row a');
    expect(() => upgradeLedger(null, 'row a')).toThrow('Unknown ledger version in row a');
    expect(() => upgradeLedger('5', 'row a')).toThrow('Unknown ledger version in row a');
  });

  it('is what loadLedger applies to the file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-ledger-'));
    const path = join(directory, 'ledger.json');
    const raw = olderLedger(3, ['treasuries', 'unresolvedPayments']);
    writeFileSync(path, JSON.stringify(raw));
    expect(loadLedger(path)).toEqual(upgradeLedger(structuredClone(raw), path));
  });
});
