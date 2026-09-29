import { describe, expect, it } from 'vitest';
import { TERMS_WINDOW_SECS } from '../src/constants';
import { type OfferTerms, publishTerms, retireTerms, termsAt, termsSince } from '../src/terms';

const USDC = 'solana:x/token:usdc';
const OTHER = 'solana:x/token:other';
const cheap: OfferTerms = { caip19: USDC, payout: 'A', amount: '1000000' };
const dear: OfferTerms = { caip19: USDC, payout: 'A', amount: '2000000' };
const rotated: OfferTerms = { caip19: USDC, payout: 'B', amount: '2000000' };
const otherCoin: OfferTerms = { caip19: OTHER, payout: 'A', amount: '5' };

describe('publishTerms', () => {
  it('ends the standing terms of the same coin, and leaves other coins alone', () => {
    let periods = publishTerms([], cheap, 100);
    periods = publishTerms(periods, otherCoin, 150);
    periods = publishTerms(periods, dear, 200);
    expect(periods).toEqual([
      { terms: cheap, from: 100, until: 200 },
      { terms: otherCoin, from: 150 },
      { terms: dear, from: 200 },
    ]);
    expect(publishTerms(periods, dear, 300)).toEqual(periods);
  });
});

describe('retireTerms', () => {
  it('ends a coin dropped from the offer, and keeps the coins still offered', () => {
    const periods = publishTerms(publishTerms([], cheap, 100), otherCoin, 150);
    const retired = retireTerms(periods, [USDC], 500);
    expect(retired).toEqual([
      { terms: cheap, from: 100 },
      { terms: otherCoin, from: 150, until: 500 },
    ]);
    expect(termsAt(retired, 500 + TERMS_WINDOW_SECS + 1)).toEqual([cheap]);
  });

  it('never reopens an older period of a dropped coin', () => {
    const otherDear: OfferTerms = { caip19: OTHER, payout: 'A', amount: '9' };
    const periods = publishTerms(publishTerms([], otherCoin, 100), otherDear, 200);
    const retired = retireTerms(periods, [], 500 + TERMS_WINDOW_SECS * 10);
    expect(retired[0]).toEqual({ terms: otherCoin, from: 100, until: 200 });
    expect(termsAt(retired, 200 + TERMS_WINDOW_SECS + 1)).toEqual([otherDear]);
  });
});

describe('termsAt', () => {
  const periods = publishTerms(
    publishTerms(publishTerms([], cheap, 100), dear, 10_000),
    rotated,
    20_000,
  );

  it('accepts what was offered within the window before the block time', () => {
    expect(termsAt(periods, 10_000 + TERMS_WINDOW_SECS - 1)).toEqual([cheap, dear]);
    expect(termsAt(periods, 20_000 + 60)).toEqual([dear, rotated]);
  });

  it('never reaches an older, cheaper price by a payment made after the window', () => {
    expect(termsAt(periods, 10_000 + TERMS_WINDOW_SECS)).toEqual([dear]);
    expect(termsAt(periods, 20_000 + TERMS_WINDOW_SECS + 1)).toEqual([rotated]);
  });

  it('never accepts terms published after the payment', () => {
    expect(termsAt(periods, 50)).toEqual([]);
    expect(termsAt(periods, 9_999)).toEqual([cheap]);
  });
});

describe('termsSince', () => {
  it('keeps every set of terms a payment from then on could still pay', () => {
    const periods = publishTerms(publishTerms([], cheap, 100), dear, 10_000);
    expect(termsSince(periods, 10_000 + TERMS_WINDOW_SECS + 1)).toEqual([dear]);
    expect(termsSince(periods, 9_000)).toEqual([cheap, dear]);
  });
});
