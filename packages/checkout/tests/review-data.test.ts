import { describe, expect, it } from 'vitest';
import { cannedViews } from '../scripts/fixtures/canned';
import { reviewFixture } from '../scripts/fixtures/review-data';
import { REVIEW_ENTRIES } from '../scripts/fixtures/review-catalog';

describe('consistent designer examples', () => {
  it('uses the same product and price without the unrelated course summary', () => {
    for (const name of ['offer', 'offer: a wallet without Tempo']) {
      const view = reviewFixture(name).view;
      if (view?.kind !== 'offer') {throw new Error('Expected offer');}
      expect(view.offer.offer.profile.name).toBe('PayCore');
      expect(view.offer.offer.product.title).toBe('Test payment');
      expect(view.offer.offer.product.summary).toBeUndefined();
      expect(view.offer.offer.product.price.amount).toBe('0.10');
      expect(view.payout.amount).toBe(100_000n);
    }
    const source = cannedViews().find((entry) => entry.name === 'offer')?.view;
    if (source?.kind !== 'offer') {throw new Error('Expected source offer');}
    expect(source.offer.offer.product.price.amount).toBe('49');
    expect(source.offer.offer.product.title).toBe('Agents 101');
  });
  it('keeps payment states, retry permissions, networks and problem reasons intact', () => {
    for (const original of cannedViews()) {
      const adapted = reviewFixture(original.name);
      expect(adapted.view?.kind).toBe(original.view?.kind);
      if (original.view?.kind === 'waiting_payment' && adapted.view?.kind === 'waiting_payment') {
        for (const key of ['canRetry', 'signed', 'followOnly', 'tempo', 'unserved'] as const) {expect(adapted.view[key]).toBe(original.view[key]);}
        expect(adapted.view.problem?.reason).toBe(original.view.problem?.reason);
        expect(adapted.view.paying?.chain).toBe(original.view.paying?.chain);
        expect(adapted.view.paying?.network).toBe(original.view.paying?.network);
        expect(adapted.view.eip3009).toEqual(original.view.eip3009);
      }
    }
  });
  it('normalizes history and freshly opened receipts without losing their statuses', async () => {
    const fixture = reviewFixture('your purchases: 3');
    const source = fixture.props!.purchases!;
    const purchases = await source.purchases();
    expect(purchases.map((purchase) => purchase.status)).toEqual(['delivered', 'refunded', 'waiting_store']);
    for (const purchase of purchases) {
      expect(purchase.receipt.store).toBe('PayCore');
      expect(purchase.receipt.paying?.amount).toBe('100000');
      expect((await source.purchase(purchase.orderId))?.receipt).toEqual(purchase.receipt);
    }
    const refreshed = reviewFixture('your purchases: detail with a sent transaction').props!.purchases!;
    const list = await refreshed.purchases();
    expect(list[0]?.receipt.sent).toBeUndefined();
    expect((await refreshed.purchase(list[0]!.orderId))?.receipt.sent?.tx).toBeTruthy();
  });
  it('resolves all gallery entries and retains explicitly labelled stress cases', () => {
    for (const entry of REVIEW_ENTRIES) {expect(() => reviewFixture(entry.fixture)).not.toThrow();}
    const stress = reviewFixture('offer: a long product name').view;
    if (stress?.kind !== 'offer') {throw new Error('Expected stress offer');}
    expect(stress.offer.offer.product.title.length).toBeGreaterThan(70);
    expect(REVIEW_ENTRIES.find((entry) => entry.id === 'your-purchases-detail-with-a-sent-transaction')?.group).toBe('extra');
  });
});
