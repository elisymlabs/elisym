import { type StoreConfig, buildCatalogAuth, buildConfigEvent, parseConfig } from '@elisym/askr';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import { FakeWeb, MemoryRelay, fixture, fixtureJson } from './connectors/helpers';
import { HOLDER, NOW, stateWith, storeRecord, syntheticStore } from './fixtures';

const BASE = 'https://api.askr.test';
const SHOP = 'https://shop.example';

function header(secret: Uint8Array, method: string, path: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: NOW,
      tags: [
        ['u', `${BASE}${path}`],
        ['method', method],
        ...(body ? [['payload', sha256Hex(body)]] : []),
        ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
      ],
      content: '',
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

async function setup(
  options: { status?: 'active' | 'pending'; source?: 'connector' | 'catalog' } = {},
) {
  const store = syntheticStore();
  const seeded = await stateWith([{ ...storeRecord(store), status: options.status ?? 'active' }]);
  const relay = new MemoryRelay();
  relay.events.push(
    finalizeEvent(
      buildCatalogAuth({ key: store.catalogKey, mode: 'hosted', createdAt: NOW - 100 }),
      store.ownerSecret,
    ),
  );
  const configEvent = finalizeEvent(
    buildConfigEvent(
      {
        assistant: store.assistant,
        origins: [SHOP],
        name: 'Shop',
        language: 'en',
        currency: 'USD',
        source:
          options.source === 'catalog'
            ? { kind: 'catalog' }
            : { kind: 'connector', platform: 'shopify' },
        catalogKey: store.catalogKey,
        createdAt: NOW - 50,
      },
      store.ownerSecret,
    ),
    store.ownerSecret,
  );
  const config: StoreConfig | undefined = parseConfig(configEvent);
  const web = new FakeWeb()
    .route(`${SHOP}/`, {
      headers: { 'content-type': 'text/html' },
      body: `<html><head><meta name="askr-verification" content="${npubEncode(store.owner)}"></head></html>`,
    })
    .route(`${SHOP}/products.json?limit=250&page=1`, {
      headers: { 'content-type': 'application/json' },
      body: fixture('shopify-products.json'),
    })
    .json(`${SHOP}/meta.json`, fixtureJson('shopify-meta.json'));
  const connectors = new ConnectorService({
    directory: seeded.directory,
    holder: HOLDER,
    client: relay,
    configFor: () => config,
    limiter: new ShopRateLimiter(0),
    fetch: web.deps(),
    pace: 1_000,
  });
  const api = createAdminApi({
    directory: seeded.directory,
    publicBase: BASE,
    syncClient: relay,
    storeEventsChanged: () => undefined,
    connectors,
    now: () => NOW,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const response = await api({
      request: new Request(`http://internal${path}`, {
        method,
        headers: { authorization: header(store.ownerSecret, method, path, text) },
        ...(text ? { body: text } : {}),
      }),
      clientAddress: '203.0.113.9',
    });
    if (!response) {
      throw new Error('not an admin path');
    }
    return { status: response.status, body: await response.json() };
  };
  return { store, relay, web, call, connectors, ...seeded };
}

describe('admin connector setup (7.3, 7.4)', () => {
  it('saves the settings, previews the first import without publishing, then enables it', async () => {
    const { call, relay, directory, state, store, connectors } = await setup();
    const saved = await call('PUT', '/v1/admin/connector', {
      platform: 'shopify',
      url: SHOP,
      importPolicies: false,
    });
    expect(saved.body.connector).toMatchObject({
      platform: 'shopify',
      url: SHOP,
      enabled: false,
      importPolicies: false,
    });
    const preview = await call('POST', '/v1/admin/connector/preview');
    expect(preview.status).toBe(200);
    expect(preview.body.result.status).toBe('ok');
    expect(preview.body.result.items).toHaveLength(3);
    expect(relay.published).toEqual([]);
    expect((await call('GET', '/v1/admin/store')).body.connector).toMatchObject({ enabled: false });
    await state.acquireLeases(HOLDER, NOW, 60);
    expect(await directory.scheduledConnectors(HOLDER, NOW)).toEqual([]);
    const enabled = await call('POST', '/v1/admin/connector/enable');
    expect(enabled.body.connector).toMatchObject({ enabled: true });
    const scheduled = await directory.scheduledConnectors(HOLDER, NOW);
    expect(scheduled.map((entry) => [entry.owner, entry.intervalMs, entry.maxProducts])).toEqual([
      [store.owner, 60 * 60_000, 1000],
    ]);
    // Another instance, which does not lease the store, does not sync it.
    expect(await directory.scheduledConnectors('other', NOW)).toEqual([]);
    connectors.stop();
  });

  it('a changed source is disabled until previewed and enabled again', async () => {
    const { call } = await setup();
    await call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    await call('POST', '/v1/admin/connector/enable');
    const same = await call('PUT', '/v1/admin/connector', {
      platform: 'shopify',
      url: SHOP,
      currency: 'EUR',
    });
    expect(same.body.connector).toMatchObject({ enabled: true, currency: 'EUR' });
    const moved = await call('PUT', '/v1/admin/connector', {
      platform: 'shopify',
      url: 'https://elsewhere.example',
    });
    expect(moved.body.connector).toMatchObject({ enabled: false });
    expect((await call('DELETE', '/v1/admin/connector')).body).toEqual({ connector: null });
    expect((await call('POST', '/v1/admin/connector/preview')).body).toEqual({
      error: 'no_connector',
    });
  });

  it('refuses bad settings, a pending store, and a config that names another source', async () => {
    const { call } = await setup();
    for (const body of [
      { platform: 'etsy', url: SHOP },
      { platform: 'shopify', url: 'not a url' },
      { platform: 'shopify', url: SHOP, currency: 'usd' },
    ]) {
      expect((await call('PUT', '/v1/admin/connector', body)).status).toBe(400);
    }
    const pending = await setup({ status: 'pending' });
    await pending.call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    expect((await pending.call('POST', '/v1/admin/connector/preview')).body).toEqual({
      error: 'inactive',
    });
    const other = await setup({ source: 'catalog' });
    await other.call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    const refused = await other.call('POST', '/v1/admin/connector/preview');
    expect(refused.body.result).toEqual({
      status: 'error',
      message: 'The store config does not name the shopify connector as its product source',
    });
    expect(other.web.requests).toEqual([]);
  });

  it('a scheduled sync saves its status', async () => {
    const { call, state, directory, store, relay } = await setup();
    await call('PUT', '/v1/admin/connector', {
      platform: 'shopify',
      url: SHOP,
      importPolicies: false,
    });
    await state.acquireLeases(HOLDER, NOW, 60);
    await call('POST', '/v1/admin/connector/enable');
    await expect
      .poll(async () => (await directory.connector(store.owner))?.lastStatus, { timeout: 5_000 })
      .toMatchObject({ status: 'ok' });
    expect(relay.published.filter((event) => event.kind === 30402)).toHaveLength(3);
  });
});
