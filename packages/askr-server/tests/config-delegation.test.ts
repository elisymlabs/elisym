import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  type StoreConfig,
  buildConfigDelegation,
  buildConfigDelegationRevocation,
  buildConfigEvent,
  decryptPrivateConfig,
  parseConfig,
} from '@elisym/askr';
import { newestDeletion, newestSigned } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  randomEventSet,
  seededRandom,
  withoutSigner,
} from '../../askr/tests/shared/config-event-sets';
import { buildStoreCatalog, isOwnerSigned, storeConfig } from '../src/worker/catalog';
import { configFilters, readStoreConfig } from '../src/worker/config-read';
import { FakePool } from './fake-pool';
import { NOW, ORIGIN, type SyntheticStore, syntheticStore } from './fixtures';

const RELAY = 'wss://relay.test';

/** `storeConfig` as it was before config delegation (frozen for 9.1). */
function frozenStoreConfig(
  events: readonly NostrEvent[],
  owner: string,
  now: number,
): StoreConfig | undefined {
  const event = newestSigned(events, KIND_CONFIG, owner, now, CONFIG_D_TAG);
  if (!event) {
    return undefined;
  }
  const deletion = newestDeletion(events, `${KIND_CONFIG}:${owner}:${CONFIG_D_TAG}`, owner, now);
  return deletion && deletion.created_at >= event.created_at ? undefined : parseConfig(event);
}

function keyOf(secret: Uint8Array) {
  return { secretKey: secret, pubkey: getPublicKey(secret) };
}

function configInput(store: SyntheticStore) {
  return {
    assistant: store.assistant,
    origins: [ORIGIN],
    name: 'Example Shop',
    language: 'en',
    currency: 'USD',
    source: { kind: 'catalog' as const },
    catalogKey: store.catalogKey,
  };
}

function delegateConfig(
  store: SyntheticStore,
  delegateSecret: Uint8Array,
  createdAt: number,
  overrides: Record<string, unknown> = {},
): NostrEvent {
  return finalizeEvent(
    buildConfigEvent(
      {
        ...configInput(store),
        name: 'Delegated Shop',
        origins: ['https://delegated.example'],
        private: { voice: 'v', instructions: 'from the delegate', notes: '' },
        createdAt,
        ...overrides,
      },
      delegateSecret,
    ),
    delegateSecret,
  );
}

function grant(store: SyntheticStore, delegate: string, createdAt: number): NostrEvent {
  return finalizeEvent(buildConfigDelegation({ key: delegate, createdAt }), store.ownerSecret);
}

describe('worker config readers with config delegation (askr-shopify 1.3, 9.1)', () => {
  it('storeConfig equals the pre-delegation reader over random event sets without 30498', () => {
    const store = syntheticStore();
    const random = seededRandom(7);
    for (let round = 0; round < 80; round += 1) {
      const events = randomEventSet(random, {
        owner: keyOf(store.ownerSecret),
        now: NOW,
        input: configInput(store),
      });
      expect(withoutSigner(storeConfig(events, store.owner, NOW))).toEqual(
        withoutSigner(frozenStoreConfig(events, store.owner, NOW)),
      );
    }
  }, 180_000);

  it('buildStoreCatalog equals the pre-delegation config pick over random event sets', () => {
    const store = syntheticStore();
    const random = seededRandom(13);
    const keyEvents = store.events.filter((event) => event.kind !== KIND_CONFIG);
    let served = 0;
    for (let round = 0; round < 80; round += 1) {
      const events = [
        ...keyEvents,
        ...randomEventSet(random, {
          owner: keyOf(store.ownerSecret),
          now: NOW,
          input: configInput(store),
        }),
      ];
      const expected = frozenStoreConfig(events, store.owner, NOW);
      const catalog = buildStoreCatalog(events, store.owner, store.assistantSecret, NOW);
      if (expected === undefined) {
        expect(catalog).toBeUndefined();
        continue;
      }
      served += 1;
      expect(withoutSigner(catalog?.config)).toEqual(withoutSigner(expected));
      expect(catalog?.privateConfig).toEqual(decryptPrivateConfig(expected, store.assistantSecret));
      expect(catalog?.items.size).toBe(2);
    }
    expect(served).toBeGreaterThan(10);
  }, 180_000);

  it("the owner's deletion of its own config address does not void a newer delegate config", () => {
    const store = syntheticStore();
    const delegateSecret = generateSecretKey();
    const events = [
      ...store.events,
      grant(store, getPublicKey(delegateSecret), NOW - 90),
      finalizeEvent(
        {
          kind: 5,
          created_at: NOW - 5,
          tags: [['a', `${KIND_CONFIG}:${store.owner}:${CONFIG_D_TAG}`]],
          content: '',
        },
        store.ownerSecret,
      ),
      delegateConfig(store, delegateSecret, NOW - 10),
    ];
    expect(storeConfig(events, store.owner, NOW)?.name).toBe('Delegated Shop');
  });

  it('config-read gives no config when the delegate read fails, never the owner-only one', async () => {
    const store = syntheticStore();
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    for (const event of [
      ...store.events,
      grant(store, delegate, NOW - 90),
      delegateConfig(store, delegateSecret, NOW - 10),
    ]) {
      relay.accept(event);
    }
    relay.holdEose = (filters) =>
      filters.some((filter) => filter.authors?.includes(delegate) === true);
    expect(await readStoreConfig(pool, RELAY, store.owner, NOW, 50)).toBeUndefined();
  });

  it("an active delegate's newer config is the store's; its private part opens; it notes no origins", () => {
    const store = syntheticStore();
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const events = [
      ...store.events,
      grant(store, delegate, NOW - 90),
      delegateConfig(store, delegateSecret, NOW - 10),
    ];
    const catalog = buildStoreCatalog(events, store.owner, store.assistantSecret, NOW);
    expect(catalog?.config.name).toBe('Delegated Shop');
    expect(catalog?.config.owner).toBe(store.owner);
    expect(catalog?.privateConfig?.instructions).toBe('from the delegate');
    expect(catalog?.items.size).toBe(2);
    expect(catalog === undefined ? true : isOwnerSigned(catalog.config)).toBe(false);
    // Without the grant the delegate's config is nobody's.
    const ungranted = buildStoreCatalog(
      [...store.events, delegateConfig(store, delegateSecret, NOW - 10)],
      store.owner,
      store.assistantSecret,
      NOW,
    );
    expect(ungranted?.config.name).toBe('Example Shop');
    expect(ungranted === undefined ? false : isOwnerSigned(ungranted.config)).toBe(true);
  });

  it("a delegate's config naming another catalog key gets no products from it", () => {
    const store = syntheticStore();
    const other = syntheticStore();
    const delegateSecret = generateSecretKey();
    const events = [
      ...store.events,
      ...other.events,
      grant(store, getPublicKey(delegateSecret), NOW - 90),
      delegateConfig(store, delegateSecret, NOW - 10, { catalogKey: other.catalogKey }),
    ];
    expect(buildStoreCatalog(events, store.owner, store.assistantSecret, NOW)?.items.size).toBe(0);
  });

  it('config-read: one REQ without a delegate, a second for active delegates; revocation reverts', async () => {
    const store = syntheticStore();
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    for (const event of store.events) {
      relay.accept(event);
    }
    expect((await readStoreConfig(pool, RELAY, store.owner, NOW))?.name).toBe('Example Shop');
    // Each filter of the owner read is its own paged REQ.
    const ownerReqs = relay.requests.length;
    expect(ownerReqs).toBe(configFilters(store.owner).length);
    relay.accept(delegateConfig(store, delegateSecret, NOW - 10));
    expect((await readStoreConfig(pool, RELAY, store.owner, NOW))?.name).toBe('Example Shop');
    expect(relay.requests.length).toBe(2 * ownerReqs);
    relay.accept(grant(store, delegate, NOW - 90));
    const read = await readStoreConfig(pool, RELAY, store.owner, NOW);
    expect(read?.name).toBe('Delegated Shop');
    expect(read?.signer).toBe(delegate);
    expect(relay.requests.length).toBeGreaterThan(3 * ownerReqs);
    expect(
      relay.requests
        .slice(3 * ownerReqs)
        .every((filters) =>
          filters.every((filter) => filter.authors?.every((author) => author === delegate)),
        ),
    ).toBe(true);
    relay.accept(
      finalizeEvent(buildConfigDelegationRevocation(delegate, NOW - 5), store.ownerSecret),
    );
    expect((await readStoreConfig(pool, RELAY, store.owner, NOW))?.name).toBe('Example Shop');
  });

  it("config-read honours the owner's deletion of the delegate's config address", async () => {
    const store = syntheticStore();
    const delegateSecret = generateSecretKey();
    const delegate = getPublicKey(delegateSecret);
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    for (const event of [
      ...store.events,
      grant(store, delegate, NOW - 90),
      delegateConfig(store, delegateSecret, NOW - 10),
      finalizeEvent(
        {
          kind: 5,
          created_at: NOW - 5,
          tags: [['a', `${KIND_CONFIG}:${delegate}:${CONFIG_D_TAG}`]],
          content: '',
        },
        store.ownerSecret,
      ),
    ]) {
      relay.accept(event);
    }
    expect((await readStoreConfig(pool, RELAY, store.owner, NOW))?.name).toBe('Example Shop');
  });
});
