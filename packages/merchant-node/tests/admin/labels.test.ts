import { describe, expect, it } from 'vitest';
import { amountText, dateText, short } from '../../src/admin/labels';

describe('labels', () => {
  it('shortens only what is longer than both ends and the dots', () => {
    const seventeen = 'a'.repeat(17);
    expect(short(seventeen)).toBe(seventeen);
    expect(short(`${'a'.repeat(8)}bc${'d'.repeat(8)}`)).toBe(`${'a'.repeat(8)}...${'d'.repeat(8)}`);
  });

  it('dates to the minute, in UTC', () => {
    expect(dateText(1_790_000_000)).toBe('2026-09-21 14:13 UTC');
  });

  it('names the network of an amount in an unknown asset when it is known', () => {
    expect(amountText({ tx: 't', amount: '7' }, 'solana-devnet')).toBe(
      '7 subunits (solana-devnet), asset unknown',
    );
    expect(amountText({ tx: 't', amount: '7' })).toBe('7 subunits, asset unknown');
  });
});
