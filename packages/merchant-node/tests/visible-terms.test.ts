import { describe, expect, it } from 'vitest';
import { type OfferTerms, publishTerms, standingTerms, visibleTerms } from '../src/terms';

const USDC = 'solana:x/token:usdc';
const OTHER = 'solana:x/token:other';
const OLD: OfferTerms[] = [{ caip19: USDC, payout: 'X', amount: '100' }];
const NEXT: OfferTerms[] = [
  { caip19: USDC, payout: 'Y', amount: '200' },
  { caip19: OTHER, payout: 'Z', amount: '200' },
];

describe('the terms buyers can read after a publish', () => {
  it('are the new ones when both the listing and the payout list went out', () => {
    expect(visibleTerms(OLD, NEXT, true, true)).toEqual(NEXT);
  });

  it('pay the old address at the new price when only the listing went out', () => {
    expect(visibleTerms(OLD, NEXT, true, false)).toEqual([
      { caip19: USDC, payout: 'X', amount: '200' },
    ]);
  });

  it('pay the new address at the old price when only the payout list went out', () => {
    expect(visibleTerms(OLD, NEXT, false, true)).toEqual([
      { caip19: USDC, payout: 'Y', amount: '100' },
    ]);
  });

  it('are the standing ones when nothing went out', () => {
    expect(visibleTerms(OLD, NEXT, false, false)).toEqual(OLD);
  });

  it('stand until replaced', () => {
    const periods = publishTerms(
      publishTerms([], OLD[0] as OfferTerms, 10),
      NEXT[0] as OfferTerms,
      20,
    );
    expect(standingTerms(periods)).toEqual([NEXT[0]]);
  });
});
