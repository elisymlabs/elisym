import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';
import { loadStoreData, storeFilters } from '../src/store-data';
import { localSecs, makeStore, sign } from './fixtures';

const STORE_AUTH_KIND = 30490;

function storeAuth(owner: ReturnType<typeof makeStore>['owner'], key: string): NostrEvent {
  return sign(
    {
      kind: STORE_AUTH_KIND,
      created_at: localSecs() - 50,
      tags: [
        ['d', key],
        ['p', key],
        ['mode', 'self-host'],
      ],
      content: '',
    },
    owner,
  );
}

describe('store data', () => {
  it('asks only for the config, 30497 and kind 5: never a 30490', () => {
    const store = makeStore();
    const kinds = storeFilters(store.owner.pubkey).flatMap((filter) => filter.kinds ?? []);
    expect(kinds).not.toContain(STORE_AUTH_KIND);
    expect(kinds.sort((left, right) => left - right)).toEqual([5, 30496, 30497]);
  });

  it('reads once, and keeps no 30490 a relay returns among the authority events', async () => {
    const store = makeStore();
    const now = localSecs();
    const config = sign(
      buildConfigEvent({ ...store.configInput, createdAt: now - 100 }, store.owner.secretKey),
      store.owner,
    );
    const grant = sign(
      buildCatalogAuth({ key: store.catalogKey.pubkey, mode: 'hosted', createdAt: now - 100 }),
      store.owner,
    );
    const calls: Filter[][] = [];
    const data = await loadStoreData(
      store.owner.pubkey,
      async (filters) => {
        calls.push(filters);
        return [config, grant, storeAuth(store.owner, store.catalogKey.pubkey)];
      },
      now,
    );
    expect(calls).toHaveLength(1);
    expect(data?.config.source).toEqual({ kind: 'catalog' });
    expect(data?.authorityEvents.map((event) => event.id)).toEqual([grant.id]);
  });

  it('a config naming a paycore source loads as no store, with no further read', async () => {
    const store = makeStore();
    const now = localSecs();
    const valid = buildConfigEvent(
      { ...store.configInput, createdAt: now - 100 },
      store.owner.secretKey,
    );
    const tags = valid.tags.map((tag) => (tag[0] === 'source' ? ['source', 'paycore'] : tag));
    const paycore = sign({ ...valid, tags }, store.owner);
    let calls = 0;
    const data = await loadStoreData(
      store.owner.pubkey,
      async () => {
        calls += 1;
        return [paycore, storeAuth(store.owner, store.catalogKey.pubkey)];
      },
      now,
    );
    expect(data).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('a config deletion within the clock skew removes the store; one further ahead is ignored', async () => {
    const store = makeStore();
    const now = localSecs();
    const config = sign(
      buildConfigEvent({ ...store.configInput, createdAt: now - 100 }, store.owner.secretKey),
      store.owner,
    );
    const load = (ahead: number) =>
      loadStoreData(
        store.owner.pubkey,
        async () => [
          config,
          sign(
            {
              kind: 5,
              created_at: now + ahead,
              tags: [['a', `30496:${store.owner.pubkey}:askr`]],
              content: '',
            },
            store.owner,
          ),
        ],
        now,
      );
    expect(await load(14 * 60)).toBeUndefined();
    expect((await load(16 * 60))?.config.name).toBe(store.configInput.name);
  });
});
