import { httpGateway } from '@elisym/comcore-widget';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway/gateway';
import { MemoryState } from '../src/state/memory';
import type { StoreRecord } from '../src/state/types';
import { buildStoreCatalog } from '../src/worker/catalog';
import { NOW, ORIGIN, TIER, storeRecord, syntheticStore } from './fixtures';

/** The widget's own gateway client against this server's handler, as on a store's page. */
function widgetAgainstServer(record: (store: ReturnType<typeof syntheticStore>) => StoreRecord) {
  const store = syntheticStore();
  const state = new MemoryState([record(store)]);
  const catalog = buildStoreCatalog(store.events, store.owner, store.assistantSecret, NOW);
  const handler = createGateway({
    state,
    gatewaySecretKey: generateSecretKey(),
    configFor: (owner) => (owner === store.owner ? catalog?.config : undefined),
    now: () => NOW,
  });
  const fetchFromPage: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('origin', ORIGIN);
    return handler({ request, clientAddress: '203.0.113.7' });
  };
  return { store, gateway: httpGateway('http://localhost', fetchFromPage) };
}

describe('widget and gateway contract (3)', () => {
  it('a grant carries the ticket, A and the branding flag', async () => {
    const { store, gateway } = widgetAgainstServer((synthetic) => storeRecord(synthetic));
    const visitor = getPublicKey(generateSecretKey());
    const result = await gateway.openSession(store.owner, visitor);
    expect(result).toMatchObject({
      kind: 'granted',
      grant: { assistant: store.assistant, branding: true },
    });
  });

  it('a tier without branding reaches the widget as such', async () => {
    const { store, gateway } = widgetAgainstServer((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, branding: false },
    }));
    const result = await gateway.openSession(store.owner, getPublicKey(generateSecretKey()));
    expect(result).toMatchObject({ kind: 'granted', grant: { branding: false } });
  });

  it('a store that is not active is the unavailable state, not an error', async () => {
    const { store, gateway } = widgetAgainstServer((synthetic) =>
      storeRecord(synthetic, 'suspended'),
    );
    const result = await gateway.openSession(store.owner, getPublicKey(generateSecretKey()));
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('a rate limit is an error to retry later', async () => {
    const { store, gateway } = widgetAgainstServer((synthetic) => ({
      ...storeRecord(synthetic),
      tier: { ...TIER, ticketsPerStorePerMinute: 1 },
    }));
    const visitor = getPublicKey(generateSecretKey());
    expect((await gateway.openSession(store.owner, visitor)).kind).toBe('granted');
    expect(await gateway.openSession(store.owner, visitor)).toEqual({ kind: 'error' });
  });
});
