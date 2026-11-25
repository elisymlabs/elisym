import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  type StoreConfig,
  buildConfigDelegation,
  buildConfigDelegationRevocation,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import { newestDeletion, newestSigned } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';
import {
  randomEventSet,
  seededRandom,
  withoutSigner,
} from '../../askr/tests/shared/config-event-sets';
import { loadStoreData, readStoreConfig } from '../src/store-data';
import { localSecs, makeStore, sign, testKey } from './fixtures';

/** `readStoreConfig` as it was before config delegation (frozen for 9.1). */
function frozenReadStoreConfig(
  events: readonly NostrEvent[],
  owner: string,
  now: number,
): StoreConfig | undefined {
  const newest = newestSigned(events, KIND_CONFIG, owner, now, CONFIG_D_TAG);
  if (!newest) {
    return undefined;
  }
  const deletion = newestDeletion(events, `${KIND_CONFIG}:${owner}:${CONFIG_D_TAG}`, owner, now);
  if (deletion && deletion.created_at >= newest.created_at) {
    return undefined;
  }
  return parseConfig(newest);
}

function matches(event: NostrEvent, filter: Filter): boolean {
  return (
    (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
    (filter.authors === undefined || filter.authors.includes(event.pubkey)) &&
    (filter['#d'] === undefined ||
      event.tags.some((tag) => tag[0] === 'd' && filter['#d']?.includes(tag[1] ?? '') === true)) &&
    (filter['#a'] === undefined ||
      event.tags.some((tag) => tag[0] === 'a' && filter['#a']?.includes(tag[1] ?? '') === true))
  );
}

function relayOf(events: readonly NostrEvent[], calls: Filter[][] = []) {
  return async (filters: Filter[]): Promise<NostrEvent[]> => {
    calls.push(filters);
    return events.filter((event) => filters.some((filter) => matches(event, filter)));
  };
}

describe('widget config reader with config delegation', () => {
  it('equals the pre-delegation reader over random event sets without 30498', () => {
    const store = makeStore();
    const now = localSecs();
    const random = seededRandom(1);
    let found = 0;
    for (let round = 0; round < 80; round += 1) {
      const events = randomEventSet(random, {
        owner: store.owner,
        now,
        input: store.configInput,
      });
      expect(withoutSigner(readStoreConfig(events, store.owner.pubkey, now))).toEqual(
        withoutSigner(frozenReadStoreConfig(events, store.owner.pubkey, now)),
      );
      if (frozenReadStoreConfig(events, store.owner.pubkey, now) !== undefined) {
        found += 1;
      }
    }
    // The sets cover both outcomes.
    expect(found).toBeGreaterThan(10);
    expect(found).toBeLessThan(70);
  }, 180_000);

  it('a store without a delegate is read in one query', async () => {
    const store = makeStore();
    const now = localSecs();
    const config = sign(
      buildConfigEvent({ ...store.configInput, createdAt: now - 10 }, store.owner.secretKey),
      store.owner,
    );
    const calls: Filter[][] = [];
    const data = await loadStoreData(store.owner.pubkey, relayOf([config], calls), now);
    expect(calls).toHaveLength(1);
    expect(data?.config.name).toBe('Shop');
  });

  it("reads an active delegate's newer config in a second query; owner stays the store", async () => {
    const store = makeStore();
    const delegate = testKey();
    const now = localSecs();
    const events = [
      sign(
        buildConfigEvent({ ...store.configInput, createdAt: now - 100 }, store.owner.secretKey),
        store.owner,
      ),
      sign(buildConfigDelegation({ key: delegate.pubkey, createdAt: now - 90 }), store.owner),
      sign(
        buildConfigEvent(
          { ...store.configInput, name: 'Delegated', createdAt: now - 10 },
          delegate.secretKey,
        ),
        delegate,
      ),
    ];
    const calls: Filter[][] = [];
    const data = await loadStoreData(store.owner.pubkey, relayOf(events, calls), now);
    expect(calls).toHaveLength(2);
    expect(data?.config.name).toBe('Delegated');
    expect(data?.config.owner).toBe(store.owner.pubkey);
    expect(data?.config.signer).toBe(delegate.pubkey);
    // Revoked: the owner's config again.
    const revoked = [
      ...events,
      sign(buildConfigDelegationRevocation(delegate.pubkey, now - 5), store.owner),
    ];
    expect((await loadStoreData(store.owner.pubkey, relayOf(revoked), now))?.config.name).toBe(
      'Shop',
    );
  });

  it("the owner's deletion of its own config address does not void a newer delegate config", () => {
    const store = makeStore();
    const delegate = testKey();
    const now = localSecs();
    const events = [
      sign(
        buildConfigEvent({ ...store.configInput, createdAt: now - 100 }, store.owner.secretKey),
        store.owner,
      ),
      sign(buildConfigDelegation({ key: delegate.pubkey, createdAt: now - 90 }), store.owner),
      sign(
        {
          kind: 5,
          created_at: now - 5,
          tags: [['a', `${KIND_CONFIG}:${store.owner.pubkey}:${CONFIG_D_TAG}`]],
          content: '',
        },
        store.owner,
      ),
      sign(
        buildConfigEvent(
          { ...store.configInput, name: 'Delegated', createdAt: now - 10 },
          delegate.secretKey,
        ),
        delegate,
      ),
    ];
    expect(readStoreConfig(events, store.owner.pubkey, now)?.name).toBe('Delegated');
  });

  it("honours the owner's deletion of the delegate's config address", () => {
    const store = makeStore();
    const delegate = testKey();
    const now = localSecs();
    const events = [
      sign(buildConfigDelegation({ key: delegate.pubkey, createdAt: now - 90 }), store.owner),
      sign(
        buildConfigEvent({ ...store.configInput, createdAt: now - 10 }, delegate.secretKey),
        delegate,
      ),
      sign(
        {
          kind: 5,
          created_at: now - 5,
          tags: [['a', `${KIND_CONFIG}:${delegate.pubkey}:${CONFIG_D_TAG}`]],
          content: '',
        },
        store.owner,
      ),
    ];
    expect(readStoreConfig(events, store.owner.pubkey, now)).toBeUndefined();
  });
});
