import {
  type StoreConfig,
  buildCatalogAuth,
  buildCatalogRevocation,
  buildConfigEvent,
  parseConfig,
} from '@elisym/comcore';
import type { NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';
import { CardCache, componentAddresses, resolveCards } from '../src/cards';
import {
  MAIN_RELAY,
  MemoryStorage,
  type TestKey,
  type TestStore,
  localSecs,
  makeStore,
  sign,
  testKey,
  FakeRelay,
  publishItem,
} from './fixtures';

function setup(sourceOverride?: Partial<TestStore['configInput']>): {
  store: TestStore;
  config: StoreConfig;
  authority: NostrEvent[];
  relay: FakeRelay;
  queries: { relays: readonly string[]; filters: Filter[] }[];
  query: (relays: readonly string[], filters: Filter[]) => Promise<NostrEvent[]>;
} {
  const store = makeStore(sourceOverride);
  const config = parseConfig(
    sign(buildConfigEvent(store.configInput, store.owner.secretKey), store.owner),
  );
  if (!config) {
    throw new Error('config did not parse');
  }
  const authority = [
    sign(
      buildCatalogAuth({
        key: store.catalogKey.pubkey,
        mode: 'hosted',
        createdAt: localSecs() - 100,
      }),
      store.owner,
    ),
  ];
  const relay = new FakeRelay();
  const queries: { relays: readonly string[]; filters: Filter[] }[] = [];
  const query = async (relays: readonly string[], filters: Filter[]): Promise<NostrEvent[]> => {
    queries.push({ relays, filters });
    return relays.flatMap((url) => relay.stored(url, filters));
  };
  return { store, config, authority, relay, queries, query };
}

function address(key: TestKey, d: string): string {
  return `30402:${key.pubkey}:${d}`;
}

const ITEM = {
  title: 'Wool scarf',
  price: { amount: '49.9', currency: 'USD' },
  url: 'https://shop.example/p/scarf',
};

describe('resolveCards', () => {
  it('fetches listings and deletions in one batched REQ and keeps only live, visible ones', async () => {
    const context = setup();
    const key = context.store.catalogKey;
    publishItem(context.relay, key, { ...ITEM, d: 'scarf' });
    publishItem(context.relay, key, { ...ITEM, d: 'sold-out-item', visibility: 'sold-out' });
    publishItem(context.relay, key, { ...ITEM, d: 'pre-order-item', visibility: 'pre-order' });
    publishItem(context.relay, key, { ...ITEM, d: 'hidden', visibility: 'hidden' });
    publishItem(context.relay, key, { ...ITEM, d: 'gone' });
    context.relay.storeOnly(
      MAIN_RELAY,
      sign(
        { kind: 5, created_at: localSecs() - 10, tags: [['a', address(key, 'gone')]], content: '' },
        key,
      ),
    );
    const wanted = ['scarf', 'sold-out-item', 'pre-order-item', 'hidden', 'gone', 'missing'].map(
      (d) => address(key, d),
    );
    const cards = await resolveCards(wanted, {
      config: context.config,
      authorityEvents: context.authority,
      query: context.query,
      cache: new CardCache(new MemoryStorage()),
      now: localSecs(),
    });
    expect([...cards.keys()].sort()).toEqual(
      ['pre-order-item', 'scarf', 'sold-out-item'].map((d) => address(key, d)).sort(),
    );
    expect(cards.get(address(key, 'sold-out-item'))?.visibility).toBe('sold-out');
    expect(context.queries).toHaveLength(1);
    expect(context.queries[0]?.filters).toEqual([
      {
        kinds: [30402],
        authors: [key.pubkey],
        '#d': ['scarf', 'sold-out-item', 'pre-order-item', 'hidden', 'gone', 'missing'],
      },
      { kinds: [5], authors: [key.pubkey], '#a': wanted },
    ]);
  });

  it('drops expired listings', async () => {
    const context = setup();
    const key = context.store.catalogKey;
    const event = sign(
      {
        kind: 30402,
        created_at: localSecs() - 50,
        tags: [
          ['d', 'old'],
          ['title', 'Old'],
          ['price', '5', 'USD'],
          ['expiration', String(localSecs() - 1)],
        ],
        content: '',
      },
      key,
    );
    context.relay.storeOnly(MAIN_RELAY, event);
    const cards = await resolveCards([address(key, 'old')], {
      config: context.config,
      authorityEvents: context.authority,
      query: context.query,
      cache: new CardCache(new MemoryStorage()),
      now: localSecs(),
    });
    expect(cards.size).toBe(0);
  });

  it('never fetches an address whose author is not the store product key with its role', async () => {
    const context = setup();
    const stranger = testKey();
    publishItem(context.relay, stranger, { ...ITEM, d: 'fake' });
    const revoked = [
      ...context.authority,
      sign(
        buildCatalogRevocation(context.store.catalogKey.pubkey, localSecs() - 5),
        context.store.owner,
      ),
    ];
    publishItem(context.relay, context.store.catalogKey, { ...ITEM, d: 'scarf' });
    const options = {
      config: context.config,
      query: context.query,
      cache: new CardCache(new MemoryStorage()),
      now: localSecs(),
    };
    expect(
      (
        await resolveCards([address(stranger, 'fake')], {
          ...options,
          authorityEvents: context.authority,
        })
      ).size,
    ).toBe(0);
    expect(
      (
        await resolveCards([address(context.store.catalogKey, 'scarf')], {
          ...options,
          authorityEvents: revoked,
        })
      ).size,
    ).toBe(0);
    expect(context.queries).toHaveLength(0);
  });

  it('a Pay Core source reads the default relays too and needs the paycore role', async () => {
    const context = setup({ source: { kind: 'paycore' }, policyKey: testKey().pubkey });
    const key = context.store.catalogKey;
    publishItem(context.relay, key, { ...ITEM, d: 'scarf' }, 'wss://nos.lol');
    const options = {
      config: context.config,
      query: context.query,
      cache: new CardCache(new MemoryStorage()),
      now: localSecs(),
    };
    expect(
      (
        await resolveCards([address(key, 'scarf')], {
          ...options,
          authorityEvents: context.authority,
        })
      ).size,
    ).toBe(0);
    const payCoreAuth = sign(
      {
        kind: 30490,
        created_at: localSecs() - 100,
        tags: [
          ['d', key.pubkey],
          ['p', key.pubkey],
          ['mode', 'self-host'],
        ],
        content: '',
      },
      context.store.owner,
    );
    const cards = await resolveCards([address(key, 'scarf')], {
      ...options,
      authorityEvents: [payCoreAuth],
    });
    expect(cards.size).toBe(1);
    expect(context.queries[0]?.relays).toContain('wss://nos.lol');
    expect(context.queries[0]?.relays).toContain(MAIN_RELAY);
  });

  it('caches results in sessionStorage, and fetches at most 50 addresses per answer', async () => {
    const context = setup();
    const key = context.store.catalogKey;
    publishItem(context.relay, key, { ...ITEM, d: 'scarf' });
    const cache = new CardCache(new MemoryStorage());
    const options = {
      config: context.config,
      authorityEvents: context.authority,
      query: context.query,
      cache,
      now: localSecs(),
    };
    await resolveCards([address(key, 'scarf')], options);
    const again = await resolveCards([address(key, 'scarf')], options);
    expect(again.size).toBe(1);
    expect(context.queries).toHaveLength(1);
    const many = Array.from({ length: 60 }, (_unused, index) => address(key, `item-${index}`));
    await resolveCards(many, options);
    expect(context.queries[1]?.filters[0]?.['#d']).toHaveLength(50);
  });
});

describe('componentAddresses', () => {
  it('collects addresses from products, comparisons and plans, once each', () => {
    const one = `30402:${'a'.repeat(64)}:one`;
    const two = `30402:${'a'.repeat(64)}:two`;
    expect(
      componentAddresses([
        { type: 'products', picks: [{ address: one }] },
        { type: 'comparison', addresses: [one, two], rows: [] },
        { type: 'plan', title: 'Plan', steps: [{ label: 'Step', addresses: [two] }] },
        { type: 'guide', title: 'Guide', sections: [{ heading: 'H', body: 'B' }] },
      ]),
    ).toEqual([one, two]);
  });
});
