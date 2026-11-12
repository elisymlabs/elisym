import { httpGateway } from '@elisym/askr-widget';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway/gateway';
import { buildStoreCatalog } from '../src/worker/catalog';
import {
  NOW,
  ORIGIN,
  type StoreSpec,
  TIER,
  stateWith,
  storeRecord,
  syntheticStore,
} from './fixtures';

/** The widget's own gateway client against this server's handler, as on a store's page. */
async function widgetAgainstServer(
  record: (store: ReturnType<typeof syntheticStore>) => StoreSpec,
  loaded = true,
) {
  const store = syntheticStore();
  const { state } = await stateWith([record(store)]);
  const active = (await state.store(store.owner))?.status === 'active';
  const catalog = buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW);
  const handler = createGateway({
    state,
    gatewaySecretKey: generateSecretKey(),
    // As in main: only leased (active) stores have a cached config.
    configFor: (owner) => (loaded && owner === store.owner && active ? catalog?.config : undefined),
    isListed: () => false,
    isUnservable: () => false,
    reserveUsd: '0.25',
    now: () => NOW,
  });
  // A browser's cross-origin fetch: a response without our origin allowed rejects, as CORS does.
  const fetchFromPage: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('origin', ORIGIN);
    const response = await handler({ request, clientAddress: '203.0.113.7' });
    if (response.headers.get('access-control-allow-origin') !== ORIGIN) {
      throw new TypeError('Failed to fetch');
    }
    return response;
  };
  return { store, gateway: httpGateway('http://localhost', fetchFromPage) };
}

describe('widget and gateway contract (3)', () => {
  it('a grant carries the ticket, A and the branding flag', async () => {
    const { store, gateway } = await widgetAgainstServer((synthetic) => storeRecord(synthetic));
    const visitor = getPublicKey(generateSecretKey());
    const result = await gateway.openSession(store.owner, visitor);
    expect(result).toMatchObject({
      kind: 'granted',
      grant: { assistant: store.assistant, branding: true },
    });
  });

  it('a tier without branding reaches the widget as such', async () => {
    const { store, gateway } = await widgetAgainstServer((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, branding: false },
    }));
    const result = await gateway.openSession(store.owner, getPublicKey(generateSecretKey()));
    expect(result).toMatchObject({ kind: 'granted', grant: { branding: false } });
  });

  it('a store that is not active is the unavailable state, not an error', async () => {
    const { store, gateway } = await widgetAgainstServer((synthetic) =>
      storeRecord(synthetic, 'suspended'),
    );
    const result = await gateway.openSession(store.owner, getPublicKey(generateSecretKey()));
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('a store this server does not know is the unavailable state too', async () => {
    const { gateway } = await widgetAgainstServer((synthetic) => storeRecord(synthetic));
    const result = await gateway.openSession('e'.repeat(64), getPublicKey(generateSecretKey()));
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('a catalog not loaded yet is an error to retry later, not the unavailable state', async () => {
    const { store, gateway } = await widgetAgainstServer(
      (synthetic) => storeRecord(synthetic),
      false,
    );
    const result = await gateway.openSession(store.owner, getPublicKey(generateSecretKey()));
    expect(result).toEqual({ kind: 'error' });
  });

  it('a rate limit is an error to retry later', async () => {
    const { store, gateway } = await widgetAgainstServer((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, ticketsPerStorePerMinute: 1 },
    }));
    const visitor = getPublicKey(generateSecretKey());
    expect((await gateway.openSession(store.owner, visitor)).kind).toBe('granted');
    expect(await gateway.openSession(store.owner, visitor)).toEqual({ kind: 'error' });
  });
});
