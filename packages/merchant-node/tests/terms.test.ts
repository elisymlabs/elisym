import { describe, expect, it } from 'vitest';
import { TERMS_WINDOW_SECS } from '../src/constants';
import {
  type OfferTerms,
  publishTerms,
  retireTerms,
  standingTerms,
  termsAt,
  termsSince,
  termsSinceAll,
  visibleTerms,
} from '../src/terms';

const USDC = 'solana:x/token:usdc';
const OTHER = 'solana:x/token:other';
const cheap: OfferTerms = { d: 'a', caip19: USDC, payout: 'A', amount: '1000000' };
const dear: OfferTerms = { d: 'a', caip19: USDC, payout: 'A', amount: '2000000' };
const rotated: OfferTerms = { d: 'a', caip19: USDC, payout: 'B', amount: '2000000' };
const otherCoin: OfferTerms = { d: 'a', caip19: OTHER, payout: 'A', amount: '5' };
const productB: OfferTerms = { d: 'b', caip19: USDC, payout: 'A', amount: '1000000' };

describe('publishTerms', () => {
  it('ends the standing terms of the same product and coin, and leaves the rest alone', () => {
    let periods = publishTerms([], cheap, 100, 100);
    periods = publishTerms(periods, otherCoin, 150, 150);
    periods = publishTerms(periods, productB, 160, 160);
    periods = publishTerms(periods, dear, 200, 200);
    expect(periods).toEqual([
      { terms: cheap, from: 100, until: 200 },
      { terms: otherCoin, from: 150 },
      { terms: productB, from: 160 },
      { terms: dear, from: 200 },
    ]);
    expect(publishTerms(periods, dear, 300, 300)).toEqual(periods);
  });

  it('M5: a price of one product never replaces another product in the same coin', () => {
    const periods = publishTerms(publishTerms([], cheap, 100, 100), productB, 200, 200);
    expect(standingTerms(periods)).toEqual([cheap, productB]);
  });

  it('starts new terms at `from` and ends the old ones at `until`: they overlap while setup runs', () => {
    const periods = publishTerms(publishTerms([], cheap, 100, 100), dear, 1_000, 1_600);
    expect(periods).toEqual([
      { terms: cheap, from: 100, until: 1_600 },
      { terms: dear, from: 1_000 },
    ]);
    expect(termsAt(periods, 'a', 1_300)).toEqual([cheap, dear]);
  });
});

describe('retireTerms', () => {
  it('ends a coin dropped from the offer, and keeps the coins still offered', () => {
    const periods = publishTerms(publishTerms([], cheap, 100, 100), otherCoin, 150, 150);
    const retired = retireTerms(periods, 'a', [USDC], 500);
    expect(retired).toEqual([
      { terms: cheap, from: 100 },
      { terms: otherCoin, from: 150, until: 500 },
    ]);
    expect(termsAt(retired, 'a', 500 + TERMS_WINDOW_SECS + 1)).toEqual([cheap]);
  });

  it('M14: retiring one product never ends another', () => {
    const periods = publishTerms(publishTerms([], cheap, 100, 100), productB, 150, 150);
    const retired = retireTerms(periods, 'a', [], 500);
    expect(standingTerms(retired)).toEqual([productB]);
  });

  it('never reopens an older period of a dropped coin', () => {
    const otherDear: OfferTerms = { d: 'a', caip19: OTHER, payout: 'A', amount: '9' };
    const periods = publishTerms(publishTerms([], otherCoin, 100, 100), otherDear, 200, 200);
    const retired = retireTerms(periods, 'a', [], 500 + TERMS_WINDOW_SECS * 10);
    expect(retired[0]).toEqual({ terms: otherCoin, from: 100, until: 200 });
    expect(termsAt(retired, 'a', 200 + TERMS_WINDOW_SECS + 1)).toEqual([otherDear]);
  });
});

describe('termsAt', () => {
  const periods = publishTerms(
    publishTerms(publishTerms([], cheap, 100, 100), dear, 10_000, 10_000),
    rotated,
    20_000,
    20_000,
  );

  it('accepts what was offered within the window before the block time', () => {
    expect(termsAt(periods, 'a', 10_000 + TERMS_WINDOW_SECS - 1)).toEqual([cheap, dear]);
    expect(termsAt(periods, 'a', 20_000 + 60)).toEqual([dear, rotated]);
  });

  it('never reaches an older, cheaper price by a payment made after the window', () => {
    expect(termsAt(periods, 'a', 10_000 + TERMS_WINDOW_SECS)).toEqual([dear]);
    expect(termsAt(periods, 'a', 20_000 + TERMS_WINDOW_SECS + 1)).toEqual([rotated]);
  });

  it('never accepts terms published after the payment', () => {
    expect(termsAt(periods, 'a', 50)).toEqual([]);
    expect(termsAt(periods, 'a', 9_999)).toEqual([cheap]);
  });

  it("only the asked product's terms: another product's price never pays for it", () => {
    const both = publishTerms(periods, productB, 100, 100);
    expect(termsAt(both, 'b', 20_000 + 60)).toEqual([productB]);
    expect(termsAt(both, 'a', 20_000 + 60)).not.toContainEqual(productB);
  });
});

describe('termsSince', () => {
  it('keeps every set of terms of the product a payment from then on could still pay', () => {
    const periods = publishTerms(
      publishTerms(publishTerms([], cheap, 100, 100), dear, 10_000, 10_000),
      productB,
      100,
      100,
    );
    expect(termsSince(periods, 'a', 10_000 + TERMS_WINDOW_SECS + 1)).toEqual([dear]);
    expect(termsSince(periods, 'a', 9_000)).toEqual([cheap, dear]);
    expect(termsSince(periods, 'b', 9_000)).toEqual([productB]);
    expect(termsSinceAll(periods, 9_000)).toEqual([cheap, dear, productB]);
  });
});

describe('the terms buyers can read', () => {
  it('are each coin of the listing read, paid to the payout list read', () => {
    expect(
      visibleTerms(
        'a',
        [
          { caip19: USDC, amount: '200' },
          { caip19: OTHER, amount: '200' },
        ],
        [{ caip19: USDC, payout: 'Y' }],
      ),
    ).toEqual([{ d: 'a', caip19: USDC, payout: 'Y', amount: '200' }]);
  });
});
