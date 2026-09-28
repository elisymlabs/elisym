import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../src/ledger';
import { payoutListDate, recordPublished, setupRefusal } from '../src/setup-ledger';
import { type OfferTerms, publishTerms, standingTerms, termsAt } from '../src/terms';

const USDC = 'solana:x/token:usdc';
const T = 1_790_000_000;
const OLD: OfferTerms = { caip19: USDC, payout: 'X', amount: '100' };
const NEW: OfferTerms = { caip19: USDC, payout: 'Y', amount: '200' };
const LIST = { createdAt: T, payouts: '["Y"]' };

function published() {
  const state = emptyLedger();
  state.terms = publishTerms([], OLD, T - 1000);
  state.payto = { createdAt: T - 1000, payouts: '["X"]' };
  state.productD = 'course';
  return state;
}

describe('recording a publish in the ledger', () => {
  it('records the new terms when both events went out', () => {
    const state = published();
    recordPublished(state, [NEW], { listing: true, payouts: true }, T, LIST, 'course');
    expect(standingTerms(state.terms)).toEqual([NEW]);
    expect(state.payto).toEqual(LIST);
    // The old terms stay payable through the window, the new ones from now.
    expect(termsAt(state.terms, T + 60)).toEqual([OLD, NEW]);
  });

  it('records the new address at the old price when only the payout list went out', () => {
    const state = published();
    recordPublished(state, [NEW], { listing: false, payouts: true }, T, LIST, 'renamed');
    expect(standingTerms(state.terms)).toEqual([{ ...NEW, amount: OLD.amount }]);
    expect(state.payto).toEqual(LIST);
    // The listing under the new id never went out: the old one is still the store's.
    expect(state.productD).toBe('course');
  });

  it('records the new price at the old address, keeping the old list, when only the listing went out', () => {
    const state = published();
    recordPublished(state, [NEW], { listing: true, payouts: false }, T, LIST, 'renamed');
    expect(standingTerms(state.terms)).toEqual([{ ...OLD, amount: NEW.amount }]);
    expect(state.payto).toEqual({ createdAt: T - 1000, payouts: '["X"]' });
    expect(state.productD).toBe('renamed');
  });

  it('retires a coin the listing dropped', () => {
    const state = published();
    recordPublished(state, [], { listing: true, payouts: true }, T, LIST, 'course');
    expect(standingTerms(state.terms)).toEqual([]);
    expect(termsAt(state.terms, T + 60)).toEqual([OLD]);
  });
});

describe('dating the payout list', () => {
  it('keeps the first date only while the relays serve that very list', () => {
    const state = published();
    expect(payoutListDate(state, '["X"]', T - 1000, T)).toBe(T - 1000);
    // The relays serve a newer list (a change whose acknowledgement was lost).
    expect(payoutListDate(state, '["X"]', T - 10, T)).toBe(T);
    expect(payoutListDate(state, '["X"]', undefined, T)).toBe(T);
    expect(payoutListDate(state, '["Z"]', T - 1000, T)).toBe(T);
    expect(payoutListDate(emptyLedger(), '["X"]', T - 1000, T)).toBe(T);
  });
});

describe('refusing a setup', () => {
  it('refuses a changed product id, and nothing else', () => {
    expect(setupRefusal(published(), 'course')).toBeUndefined();
    expect(setupRefusal(published(), 'other')).toContain('product id changed');
    expect(setupRefusal(emptyLedger(), 'anything')).toBeUndefined();
  });
});
