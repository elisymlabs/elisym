import { describe, expect, it } from 'vitest';
import { cannedViews } from '../scripts/fixtures/canned';
import { REVIEW_ENTRIES, REVIEW_GROUPS, entriesForGroup, initialReviewEntry } from '../scripts/fixtures/review-catalog';

describe('designer review navigation', () => {
  it('retains every existing scenario except the exact Tempo duplicate', () => {
    const expected = cannedViews().map((entry) => entry.name).filter((name) => name !== 'offer: Tempo wallets').sort();
    const actual = REVIEW_ENTRIES.map((entry) => entry.fixture).filter((name) => !name.startsWith('review:')).sort();
    expect(actual).toEqual(expected);
    expect(new Set(REVIEW_ENTRIES.map((entry) => entry.id)).size).toBe(REVIEW_ENTRIES.length);
  });
  it('puts the main flow in payment order, with order creation before wallet approval', () => {
    expect(entriesForGroup('flow').map((entry) => entry.fixture)).toEqual([
      'offer', 'working: waiting for the wallet', 'review: creating order', 'working',
      'waiting for the payment', 'waiting for the store', 'payment complete',
    ]);
  });
  it('resolves old numeric links and prefers an explicitly shared stable state', () => {
    expect(initialReviewEntry(new URLSearchParams('screen=20')).fixture).toBe('offer: a wallet without Tempo');
    expect(initialReviewEntry(new URLSearchParams('screen=19')).fixture).toBe('offer: Tempo mainnet');
    expect(initialReviewEntry(new URLSearchParams('screen=20&state=cancelled')).fixture).toBe('cancelled');
    expect(initialReviewEntry(new URLSearchParams('screen=garbage')).fixture).toBe('offer');
  });
  it('gives every screen a description and keeps advanced networks outside the main flow', () => {
    for (const entry of REVIEW_ENTRIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(REVIEW_GROUPS.some((group) => group.id === entry.group)).toBe(true);
      if (entry.fixture.startsWith('Base:') || entry.fixture.startsWith('offer: Base')) {expect(entry.group).toBe('extra');}
    }
  });
});
