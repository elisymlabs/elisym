import { parseCaip19 } from '@elisym/commerce';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USDC_DEVNET_CAIP19 } from '../../merchant-node/tests/admin/fixtures';
import type { OrderRow } from '../src/lib/core';
import { CSV_COLUMNS, csvCell, csvFileName, ordersCsv } from '../src/lib/csv';
import { downloadText } from '../src/lib/download';

const USDC = parseCaip19(USDC_DEVNET_CAIP19);
if (USDC === undefined) {
  throw new Error('USDC devnet is a known asset');
}

function row(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    key: 'buyer:order',
    buyerPubkey: 'b'.repeat(64),
    orderId: 'order-1',
    createdAt: 1_790_000_000,
    order: {
      type: 'order',
      storePubkey: 's'.repeat(64),
      orderId: 'order-1',
      items: [{ product: '30402:x:d', quantity: 1 }],
      total: { amount: '1.5', currency: 'USD' },
      email: 'a@b.c',
      customerRef: 'user-42',
    },
    product: 'Course',
    conflict: false,
    orderNotLoaded: false,
    claimCheck: 'matches',
    state: 'delivered',
    credits: [{ tx: 'tx-1', amount: '1500000', asset: USDC, medium: 'solana-devnet' }],
    refunds: [],
    reported: [],
    unlistedMedium: false,
    ...overrides,
  };
}

function orderOf(base: OrderRow): NonNullable<OrderRow['order']> {
  if (base.order === undefined) {
    throw new Error('the base row has an order');
  }
  return base.order;
}

function lines(csv: string): string[][] {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  return csv
    .slice(1, -2)
    .split('\r\n')
    .map((line) => line.slice(1, -1).split('","'));
}

describe('ordersCsv', () => {
  it('writes a BOM, CRLF lines, the header and one quoted line per order with full values', () => {
    const [header, first] = lines(ordersCsv([row()]));
    expect(header).toEqual([...CSV_COLUMNS]);
    const cell = (name: (typeof CSV_COLUMNS)[number]) => first?.[CSV_COLUMNS.indexOf(name)];
    expect(cell('time_utc')).toBe('2026-09-21T14:13:20.000Z');
    expect(cell('claimed_total')).toBe('1.5 USD');
    expect(cell('claim_check')).toBe('matches the listing');
    expect(cell('state')).toBe('completed');
    expect(cell('credited')).toBe('1.5');
    expect(cell('credited_asset')).toBe(USDC_DEVNET_CAIP19);
    expect(cell('transactions')).toBe('tx-1');
    expect(cell('buyer_pubkey')).toBe('b'.repeat(64));
  });

  it('writes unknown assets as raw subunits, and refunds without a medium as unknown', () => {
    const [, first] = lines(
      ordersCsv([
        row({
          credits: [{ tx: 'tx-1', amount: '7', medium: 'solana-devnet' }],
          refunds: [{ tx: 'tx-2', amount: '3' }],
        }),
      ]),
    );
    const cell = (name: (typeof CSV_COLUMNS)[number]) => first?.[CSV_COLUMNS.indexOf(name)];
    expect(cell('credited')).toBe('7 subunits');
    expect(cell('credited_asset')).toBe('unknown (solana-devnet)');
    expect(cell('refunded')).toBe('3 subunits');
    expect(cell('refunded_asset')).toBe('unknown');
    expect(cell('transactions')).toBe('tx-1; tx-2');
  });

  it('writes a refund in a known asset as whole units and its asset', () => {
    const [, first] = lines(
      ordersCsv([row({ credits: [], refunds: [{ tx: 'tx-r', amount: '250000', asset: USDC }] })]),
    );
    expect(first?.[CSV_COLUMNS.indexOf('refunded')]).toBe('0.25');
    expect(first?.[CSV_COLUMNS.indexOf('refunded_asset')]).toBe(USDC_DEVNET_CAIP19);
  });

  it('leaves the claimed total empty without a single order, and notes why', () => {
    for (const flags of [{ conflict: true }, { orderNotLoaded: true }]) {
      const [, first] = lines(ordersCsv([row({ ...flags, unlistedMedium: true })]));
      expect(first?.[CSV_COLUMNS.indexOf('claimed_total')]).toBe('');
      expect(first?.[CSV_COLUMNS.indexOf('notes')]).toMatch(
        /(conflict|order not loaded); unlisted medium/,
      );
    }
  });

  it('lists only the credited transactions when the node credited something', () => {
    const [, first] = lines(
      ordersCsv([row({ reported: [{ medium: 'solana-devnet', tx: 'reported-1' }] })]),
    );
    expect(first?.[CSV_COLUMNS.indexOf('transactions')]).toBe('tx-1');
  });

  it('lists the refund transaction, not a reported one, for a refunded order', () => {
    const [, first] = lines(
      ordersCsv([
        row({
          credits: [],
          state: 'refunded',
          refunds: [{ tx: 'refund-tx', amount: '1' }],
          reported: [{ medium: 'solana-devnet', tx: 'rep-1' }],
        }),
      ]),
    );
    expect(first?.[CSV_COLUMNS.indexOf('transactions')]).toBe('refund-tx');
  });

  it('falls back to the reported transactions when the node credited nothing', () => {
    const [, first] = lines(
      ordersCsv([
        row({
          credits: [],
          state: 'payment_reported',
          reported: [{ medium: 'solana-devnet', tx: 'rep-1' }],
        }),
      ]),
    );
    expect(first?.[CSV_COLUMNS.indexOf('transactions')]).toBe('rep-1');
  });

  it('defuses formulas in every cell and escapes quotes', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${start}HYPERLINK("x")`)).toBe(`"'${start}HYPERLINK(""x"")"`);
    }
    expect(csvCell('plain')).toBe('"plain"');
    const csv = ordersCsv([
      row({
        orderId: '=1+1',
        product: '+SUM(A1)',
        order: { ...orderOf(row()), email: '@cmd', customerRef: '-2' },
      }),
    ]);
    for (const formula of ['=1+1', '+SUM(A1)', '@cmd', '-2']) {
      expect(csv).toContain(`"'${formula}"`);
    }
  });

  it('names the file after the store and the day', () => {
    expect(csvFileName('abcdef0123456789', new Date('2026-10-12T15:00:00Z'))).toBe(
      'elisym-orders-abcdef01-2026-10-12.csv',
    );
  });
});

describe('downloadText', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('revokes the object URL only after the click returned', () => {
    vi.useFakeTimers();
    const order: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => order.push('revoke'));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => order.push('click'));
    downloadText(document, 'a,b', 'x.csv', 'text/csv');
    expect(order).toEqual(['click']);
    vi.runAllTimers();
    expect(order).toEqual(['click', 'revoke']);
  });
});
