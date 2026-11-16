// cspell:ignore EtWTRABZaYq6iMfeYKouRu166VU2xqa1 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
import { KIND_CATALOG_AUTH, KIND_CONFIG } from '@elisym/askr';
import { buildProductEvent } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
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

describe('no paycore source on the server', () => {
  it('asks the relay for no 30490', () => {
    const store = syntheticStore();
    const kinds = [
      ...ownerFilters(store.owner),
      ...keyFilters(store.catalogKey, store.catalogKey),
    ].flatMap((filter) => filter.kinds ?? []);
    expect(kinds).not.toContain(STORE_AUTH_KIND);
    expect(ownerFilters(store.owner)).toEqual([
      { kinds: [KIND_CONFIG, KIND_CATALOG_AUTH, 5], authors: [store.owner] },
    ]);
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

  it('a listing of the catalog key that carries payment terms is left out', () => {
    const store = syntheticStore();
    const paid = finalizeEvent(
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
    const catalog = buildStoreCatalog(
      [...store.events, paid],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect(catalog?.items.size).toBe(2);
    expect(catalog?.items.has('paid')).toBe(false);
  });
});
