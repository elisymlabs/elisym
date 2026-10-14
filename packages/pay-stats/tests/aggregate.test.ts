import { describe, expect, it } from 'vitest';
import { type Candidate, aggregate, usdOf, utcDay } from '../src/aggregate';

const PAYOUT = '0x5696da2cecea22f127948458382ac2c59bc8e4bb';
const OTHER_PAYOUT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TREASURY = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

function candidate(change: Partial<Candidate> = {}): Candidate {
  return {
    rail: 'tempo',
    network: 'mainnet',
    reference: `0xfab22e7e${'01'.repeat(28)}`,
    day: '2026-10-20',
    position: { primary: 100, secondary: 0 },
    coin: 'USDC.e',
    payout: PAYOUT,
    provider: 49_000_000n,
    fees: [],
    ...change,
  };
}

describe('counting purchases', () => {
  it('counts a reference once, and its later transfer as a duplicate', () => {
    const report = aggregate(
      [
        candidate({ position: { primary: 200, secondary: 0 } }),
        candidate({ position: { primary: 100, secondary: 0 } }),
      ],
      [],
    );
    expect(report.purchases).toEqual([
      expect.objectContaining({
        count: 1,
        gross_subunits: '49000000',
        duplicate_transfers: 1,
        duplicate_subunits: '49000000',
      }),
    ]);
  });

  it('sums a duplicate with its fee legs, apart from the purchase and the fee rows', () => {
    const report = aggregate(
      [
        candidate({ position: { primary: 100, secondary: 0 } }),
        candidate({
          position: { primary: 200, secondary: 0 },
          provider: 48_000_000n,
          fees: [{ treasury: TREASURY, amount: 1_000_000n }],
        }),
      ],
      [],
    );
    expect(report.purchases).toEqual([
      expect.objectContaining({
        count: 1,
        gross_subunits: '49000000',
        fee_subunits: '0',
        duplicate_transfers: 1,
        duplicate_subunits: '49000000',
      }),
    ]);
    expect(report.fees).toEqual([]);
  });

  it('keeps a reference first paid before --since a duplicate inside the window', () => {
    const report = aggregate(
      [
        candidate({ day: '2026-10-19', position: { primary: 100, secondary: 0 } }),
        candidate({ day: '2026-10-20', position: { primary: 200, secondary: 0 } }),
      ],
      [],
      { since: '2026-10-20' },
    );
    expect(report.purchases).toEqual([
      expect.objectContaining({ day: '2026-10-20', count: 0, duplicate_transfers: 1 }),
    ]);
  });

  it('counts one reference on two tokens once, at the earlier transfer', () => {
    const report = aggregate(
      [
        candidate({ coin: 'pathUSD', provider: 5n, position: { primary: 300, secondary: 0 } }),
        candidate({ coin: 'USDC.e', provider: 7n, position: { primary: 299, secondary: 4 } }),
      ],
      [],
    );
    const counted = report.purchases.filter((row) => row.count > 0);
    expect(counted).toEqual([
      expect.objectContaining({ coin: 'USDC.e', count: 1, gross_subunits: '7' }),
    ]);
    expect(report.purchases.find((row) => row.coin === 'pathUSD')).toMatchObject({
      count: 0,
      duplicate_transfers: 1,
      duplicate_subunits: '5',
    });
  });

  it('orders inside a block by log index, and inside a slot by signature', () => {
    const tempo = aggregate(
      [
        candidate({ coin: 'B', position: { primary: 1, secondary: 10 } }),
        candidate({ coin: 'A', position: { primary: 1, secondary: 9 } }),
      ],
      [],
    );
    expect(tempo.purchases.find((row) => row.count === 1)?.coin).toBe('A');
    const solana = aggregate(
      [
        candidate({ rail: 'solana', coin: 'B', position: { primary: 1, secondary: 'b' } }),
        candidate({ rail: 'solana', coin: 'A', position: { primary: 1, secondary: 'a' } }),
      ],
      [],
    );
    expect(solana.purchases.find((row) => row.count === 1)?.coin).toBe('A');
  });

  it('sums the gross as provider plus fee, with the fee reported apart per treasury', () => {
    const report = aggregate(
      [
        candidate({ provider: 48_510_000n, fees: [{ treasury: TREASURY, amount: 490_000n }] }),
        candidate({
          reference: `0xfab22e7e${'02'.repeat(28)}`,
          provider: 1n,
          fees: [{ treasury: TREASURY, amount: 2n }],
        }),
      ],
      [],
    );
    expect(report.purchases).toEqual([
      expect.objectContaining({
        count: 2,
        gross_subunits: '49000003',
        gross_usd: '49.000003',
        provider_subunits: '48510001',
        fee_subunits: '490002',
      }),
    ]);
    expect(report.fees).toEqual([
      {
        day: '2026-10-20',
        rail: 'tempo',
        network: 'mainnet',
        coin: 'USDC.e',
        treasury: TREASURY,
        fee_count: 2,
        fee_subunits: '490002',
        fee_usd: '0.490002',
      },
    ]);
  });

  it('keeps one row per payout, day and coin', () => {
    const report = aggregate(
      [
        candidate(),
        candidate({ reference: 'b', payout: OTHER_PAYOUT }),
        candidate({ reference: 'c', day: '2026-10-21' }),
      ],
      [],
    );
    expect(report.purchases.map((row) => [row.day, row.payout, row.count])).toEqual([
      ['2026-10-20', PAYOUT, 1],
      ['2026-10-20', OTHER_PAYOUT, 1],
      ['2026-10-21', PAYOUT, 1],
    ]);
  });

  it('gives no USD for a coin that is not a dollar peg', () => {
    const report = aggregate([candidate({ rail: 'solana', coin: 'SOL', provider: 10n })], []);
    expect(report.purchases[0]).toMatchObject({ gross_subunits: '10', gross_usd: '' });
    expect(usdOf('LSM', 1_000_000n)).toBe('');
    expect(usdOf('USDC', 1_000_000n)).toBe('1');
    expect(usdOf('pathUSD', 1n)).toBe('0.000001');
  });

  it('sums exactly past 2^53', () => {
    const big = 2n ** 60n + 1n;
    const report = aggregate(
      [candidate({ provider: big }), candidate({ reference: 'b', provider: big })],
      [],
    );
    expect(report.purchases[0]?.gross_subunits).toBe((big * 2n).toString());
    expect(report.purchases[0]?.gross_usd).toBe('2305843009213.693954');
  });

  it('filters the context by the window, summing per day, rail and bucket', () => {
    const report = aggregate(
      [],
      [
        { day: '2026-10-19', rail: 'solana', bucket: 'job', count: 1 },
        { day: '2026-10-20', rail: 'solana', bucket: 'job', count: 1 },
        { day: '2026-10-20', rail: 'solana', bucket: 'job', count: 2 },
        { day: '2026-10-20', rail: 'solana', bucket: 'untagged', count: 1 },
      ],
      { since: '2026-10-20', until: '2026-10-20' },
    );
    expect(report.context).toEqual([
      { day: '2026-10-20', rail: 'solana', bucket: 'job', count: 3 },
      { day: '2026-10-20', rail: 'solana', bucket: 'untagged', count: 1 },
    ]);
  });
});

describe('utcDay', () => {
  it('cuts days at UTC midnight', () => {
    const midnight = Date.parse('2026-10-21T00:00:00Z') / 1000;
    expect(utcDay(midnight - 1)).toBe('2026-10-20');
    expect(utcDay(midnight)).toBe('2026-10-21');
  });
});
