// cspell:ignore EtWTRABZaYq6iMfeYKouRu166VU2xqa1 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
import { KIND_CATALOG_AUTH, KIND_CONFIG } from '@elisym/askr';
import {
  buildProductEvent,
  buildStoreAuthEvent,
  buildStoreRevocationEvent,
} from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { buildStoreCatalog, keyFilters, ownerFilters } from '../src/worker/catalog';
import { NOW, type SyntheticStore, syntheticStore } from './fixtures';

const STORE_AUTH_KIND = 30490;

function storeAuthOf(store: SyntheticStore): NostrEvent {
  return finalizeEvent(
    {
      kind: STORE_AUTH_KIND,
      created_at: NOW - 100,
      tags: [
        ['d', store.catalogKey],
        ['p', store.catalogKey],
        ['mode', 'hosted'],
      ],
      content: '',
    },
    store.ownerSecret,
  );
}

function withPaycoreSource(store: SyntheticStore): NostrEvent[] {
  return store.events.map((event) =>
    event.kind === KIND_CONFIG
      ? finalizeEvent(
          {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags.map((tag) => (tag[0] === 'source' ? ['source', 'paycore'] : tag)),
            content: event.content,
          },
          store.ownerSecret,
        )
      : event,
  );
}

describe('a PayCore store as a catalog source on the server', () => {
  it("asks the relay for the owner's 30490s with the rest of the authority, the keys' never", () => {
    const store = syntheticStore();
    expect(ownerFilters(store.owner)).toEqual([
      { kinds: [KIND_CONFIG, KIND_CATALOG_AUTH, STORE_AUTH_KIND, 5], authors: [store.owner] },
    ]);
    const keyKinds = keyFilters(store.catalogKey, store.catalogKey).flatMap(
      (filter) => filter.kinds ?? [],
    );
    expect(keyKinds).not.toContain(STORE_AUTH_KIND);
  });

  it('a config naming a paycore source builds no catalog, without throwing', () => {
    const store = syntheticStore();
    const events = [...withPaycoreSource(store), storeAuthOf(store)];
    expect(() => buildStoreCatalog(events, store.owner, store.assistantSecret, NOW)).not.toThrow();
    expect(buildStoreCatalog(events, store.owner, store.assistantSecret, NOW)).toBeUndefined();
    expect(
      buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW)?.items.size,
    ).toBe(2);
  });

  it('a 30490 gives the catalog key neither products nor policies', () => {
    const store = syntheticStore();
    const events = [
      ...store.events.filter((event) => event.kind !== KIND_CATALOG_AUTH),
      storeAuthOf(store),
    ];
    const catalog = buildStoreCatalog(events, store.owner, store.assistantSecret, NOW);
    expect(catalog?.items.size).toBe(0);
    expect(catalog?.policies).toEqual([]);
  });

  it('a listing of the catalog key that carries payment terms is shown, payable only with an active 30490', () => {
    const store = syntheticStore();
    const paid = paidListingOf(store);
    const without = buildStoreCatalog(
      [...store.events, paid],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect(without?.items.size).toBe(3);
    expect(without?.items.get('paid')?.payable).toBeUndefined();
    const withAuth = buildStoreCatalog(
      [...store.events, paid, storeAuthOf(store)],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect(withAuth?.items.get('paid')?.payable?.network).toBe('devnet');
    // Listings without payment terms never become payable.
    const unpaid = [...(withAuth?.items.values() ?? [])].filter((item) => item.d !== 'paid');
    expect(unpaid.length).toBe(2);
    expect(unpaid.every((item) => item.payable === undefined)).toBe(true);
  });

  it('a 30490 that expires later gives Buy now', () => {
    const store = syntheticStore();
    const later = finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: store.catalogKey,
        mode: 'hosted',
        createdAt: NOW - 50,
        expiresAt: NOW + 100,
      }),
      store.ownerSecret,
    );
    const catalog = buildStoreCatalog(
      [...store.events, paidListingOf(store), later],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect(catalog?.items.get('paid')?.payable?.network).toBe('devnet');
  });

  it('a 30490 revocation, deletion or expiry removes Buy, never the product', () => {
    const store = syntheticStore();
    const base = [...store.events, paidListingOf(store), storeAuthOf(store)];
    const revocation = finalizeEvent(
      buildStoreRevocationEvent(store.catalogKey, NOW - 10),
      store.ownerSecret,
    );
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: NOW - 10,
        tags: [['a', `${STORE_AUTH_KIND}:${store.owner}:${store.catalogKey}`]],
        content: '',
      },
      store.ownerSecret,
    );
    for (const ending of [revocation, deletion]) {
      const catalog = buildStoreCatalog([...base, ending], store.owner, store.assistantSecret, NOW);
      expect(catalog?.items.get('paid')).toBeDefined();
      expect(catalog?.items.get('paid')?.payable).toBeUndefined();
    }
    const expired = finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: store.catalogKey,
        mode: 'hosted',
        createdAt: NOW - 50,
        expiresAt: NOW - 1,
      }),
      store.ownerSecret,
    );
    const lapsed = buildStoreCatalog(
      [...store.events, paidListingOf(store), expired],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect(lapsed?.items.get('paid')).toBeDefined();
    expect(lapsed?.items.get('paid')?.payable).toBeUndefined();
  });

  it('a 30490 signed by someone else, or for another key, gives no Buy', () => {
    const store = syntheticStore();
    const stranger = generateSecretKey();
    const foreign = finalizeEvent(
      buildStoreAuthEvent({ storePubkey: store.catalogKey, mode: 'hosted', createdAt: NOW - 50 }),
      stranger,
    );
    const otherKey = finalizeEvent(
      buildStoreAuthEvent({
        storePubkey: getPublicKey(generateSecretKey()),
        mode: 'hosted',
        createdAt: NOW - 50,
      }),
      store.ownerSecret,
    );
    for (const auth of [foreign, otherKey]) {
      const catalog = buildStoreCatalog(
        [...store.events, paidListingOf(store), auth],
        store.owner,
        store.assistantSecret,
        NOW,
      );
      expect(catalog?.items.get('paid')?.payable).toBeUndefined();
    }
  });
});

function paidListingOf(store: SyntheticStore): NostrEvent {
  return finalizeEvent(
    buildProductEvent({
      d: 'paid',
      title: 'Paid',
      description: '',
      price: { amount: '5', currency: 'USD' },
      accept: [
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      ],
      createdAt: NOW - 50,
    }),
    store.catalogSecret,
  );
}
