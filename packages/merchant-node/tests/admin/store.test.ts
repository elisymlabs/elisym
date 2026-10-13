import { buildProductEvent } from '@elisym/commerce';
import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { mergeNewestListings } from '../../src/admin/store';
import { D, T0, USDC_DEVNET_CAIP19, type Key, key, productOf } from './fixtures';

function listing(store: Key, createdAt: number, title = 'Course', d = D) {
  return finalizeEvent(
    buildProductEvent({
      d,
      title,
      description: '',
      price: { amount: '1', currency: 'USD' },
      accept: [USDC_DEVNET_CAIP19],
      createdAt,
    }),
    store.secretKey,
  );
}

describe('mergeNewestListings', () => {
  it('keeps the newest listing per product, and never drops one kept before', () => {
    const store = key();
    const older = listing(store, T0 - 100, 'Old');
    const newer = listing(store, T0 - 50, 'New');
    const other = listing(store, T0 - 70, 'Other', 'other');
    const first = mergeNewestListings(new Map(), [older, other], store.pubkey, T0);
    expect(first.get(productOf(store))?.id).toBe(older.id);

    const second = mergeNewestListings(first, [newer], store.pubkey, T0);
    expect(second.get(productOf(store))?.id).toBe(newer.id);
    expect(second.get(productOf(store, 'other'))?.id).toBe(other.id);

    const stale = mergeNewestListings(second, [older], store.pubkey, T0);
    expect(stale.get(productOf(store))?.id).toBe(newer.id);
    // The input map is not changed.
    expect(first.get(productOf(store))?.id).toBe(older.id);
  });

  it("ignores another store's listing and one dated too far ahead", () => {
    const store = key();
    const stranger = key();
    const foreign = listing(stranger, T0 - 10);
    const future = listing(store, T0 + 24 * 60 * 60);
    const merged = mergeNewestListings(new Map(), [foreign, future], store.pubkey, T0);
    expect(merged.size).toBe(0);
  });

  it('keeps a kept listing over an older one and over its own copy, and takes a newer one', () => {
    const store = key();
    const kept = listing(store, T0 - 50, 'Kept');
    const older = listing(store, T0 - 100, 'Older');
    const merged = mergeNewestListings(
      new Map([[productOf(store), kept]]),
      [older, { ...kept }],
      store.pubkey,
      T0,
    );
    expect(merged.get(productOf(store))).toBe(kept);
    const newer = listing(store, T0 - 10, 'Newer');
    expect(mergeNewestListings(merged, [newer], store.pubkey, T0).get(productOf(store))?.id).toBe(
      newer.id,
    );
  });

  it('breaks a tie of dates by the lowest id, as the buyer side does', () => {
    const store = key();
    const [low, high] = [listing(store, T0 - 30, 'A'), listing(store, T0 - 30, 'B')].sort(
      (first, second) => (first.id < second.id ? -1 : 1),
    );
    if (low === undefined || high === undefined) {
      throw new Error('two listings');
    }
    const address = productOf(store);
    expect(
      mergeNewestListings(new Map([[address, high]]), [low], store.pubkey, T0).get(address),
    ).toBe(low);
    expect(
      mergeNewestListings(new Map([[address, low]]), [high], store.pubkey, T0).get(address),
    ).toBe(low);
  });

  it('never takes a newer listing it cannot read as a product', () => {
    const store = key();
    const unreadable = finalizeEvent(
      { kind: 30402, created_at: T0 - 5, tags: [['d', D]], content: '' },
      store.secretKey,
    );
    const kept = listing(store, T0 - 50, 'Kept');
    const address = productOf(store);
    expect(
      mergeNewestListings(new Map([[address, kept]]), [unreadable], store.pubkey, T0).get(address),
    ).toBe(kept);
    expect(mergeNewestListings(new Map(), [unreadable], store.pubkey, T0).size).toBe(0);
  });

  it('reads no more of a copy of a kept listing than its id and signature', () => {
    const store = key();
    const kept = listing(store, T0 - 50, 'Kept');
    let contentReads = 0;
    const copy = { ...kept };
    Object.defineProperty(copy, 'content', {
      get() {
        contentReads += 1;
        return kept.content;
      },
    });
    mergeNewestListings(new Map([[productOf(store), kept]]), [copy], store.pubkey, T0);
    // A signature check reads the content: the copy is skipped before any check.
    expect(contentReads).toBe(0);
  });
});
