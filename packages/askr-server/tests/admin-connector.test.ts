import { type StoreConfig, buildCatalogAuth, buildConfigEvent, parseConfig } from '@elisym/askr';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import type { FetchGuardDeps } from '../src/connectors/fetch-guard';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import type { ConnectorRecord } from '../src/state/stores';
import { readStoreConfig } from '../src/worker/config-read';
import { FakeWeb, MemoryRelay, fixture, fixtureJson } from './connectors/helpers';
import { FakePool } from './fake-pool';
import { HOLDER, NOW, stateWith, storeRecord, syntheticStore } from './fixtures';

const BASE = 'https://api.askr.test';
const SHOP = 'https://shop.example';
const RELAY = 'wss://relay.test';

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
  options: {
    status?: 'active' | 'pending';
    source?: 'connector' | 'catalog';
    platform?: 'shopify' | 'google';
    /** The config's shop URL (default the shop); null signs the old form without one. */
    shopUrl?: string | null;
    origins?: string[];
    linkOrigins?: string[];
    /** False: this instance's catalog cache lacks the config (it does not lease the store). */
    cached?: boolean;
  } = {},
) {
  const platform = options.platform ?? 'shopify';
  const defaultShopUrl = platform === 'google' ? null : SHOP;
  const shopUrl = options.shopUrl === undefined ? defaultShopUrl : options.shopUrl;
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
        origins: options.origins ?? [SHOP],
        linkOrigins: options.linkOrigins ?? [],
        name: 'Shop',
        language: 'en',
        currency: 'USD',
        source:
          options.source === 'catalog'
            ? { kind: 'catalog' }
            : {
                kind: 'connector',
                platform,
                ...(shopUrl === null ? {} : { shopUrl }),
              },
        catalogKey: store.catalogKey,
        createdAt: NOW - 50,
      },
      store.ownerSecret,
    ),
    store.ownerSecret,
  );
  const config: StoreConfig | undefined = parseConfig(configEvent);
  // The relay the instance reads the config from when its cache lacks it.
  const relayPool = new FakePool();
  relayPool.relay(RELAY).accept(configEvent);
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
  const newConnectors = () =>
    new ConnectorService({
      directory: seeded.directory,
      holder: HOLDER,
      client: relay,
      configFor: () => (options.cached === false ? undefined : config),
      readConfig: (owner) => readStoreConfig(relayPool, RELAY, owner, NOW),
      limiter: new ShopRateLimiter(0),
      fetch: web.deps(),
      pace: 1_000,
    });
  const connectors = newConnectors();
  /** An instance's admin API over the shared database. */
  const instance = (instanceConnectors: ConnectorService) =>
    createAdminApi({
      directory: seeded.directory,
      publicBase: BASE,
      syncClient: relay,
      storeEventsChanged: () => undefined,
      connectors: instanceConnectors,
      now: () => NOW,
    });
  const callOn =
    (api: ReturnType<typeof createAdminApi>) =>
    async (method: string, path: string, body?: unknown) => {
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
  const call = callOn(instance(connectors));
  /** The same calls on a second instance. */
  const callOther = callOn(instance(newConnectors()));
  return { store, relay, relayPool, web, call, callOther, connectors, config, ...seeded };
}

/** The shop answers each request only after `delayMs`. */
function slowWeb(web: FakeWeb, delayMs: number): FetchGuardDeps {
  const deps = web.deps();
  const transport = deps.transport;
  if (transport === undefined) {
    throw new Error('the fake web has no transport');
  }
  return {
    ...deps,
    transport: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return transport(request);
    },
  };
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

  it("syncs only the shop the config's source names, compared by origin and path", async () => {
    const named = await setup({ shopUrl: SHOP });
    await named.call('PUT', '/v1/admin/connector', { platform: 'shopify', url: `${SHOP}/` });
    expect((await named.call('POST', '/v1/admin/connector/preview')).body.result.status).toBe('ok');

    const elsewhere = await setup({ shopUrl: `${SHOP}/store` });
    await elsewhere.call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    expect((await elsewhere.call('POST', '/v1/admin/connector/preview')).body.result).toEqual({
      status: 'error',
      message: 'The store config names another shop URL than the connector',
    });
    expect(elsewhere.web.requests).toEqual([]);

    const pathed = await setup({ shopUrl: `${SHOP}/store` });
    await pathed.call('PUT', '/v1/admin/connector', {
      platform: 'shopify',
      url: `${SHOP}/store/?utm=x`,
    });
    expect((await pathed.call('POST', '/v1/admin/connector/preview')).body.result.status).toBe(
      'ok',
    );
  });

  it('refuses a config without the shop URL (the old form), even when the shop is a link origin', async () => {
    const old = await setup({ shopUrl: null });
    await old.call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    const refusal = {
      status: 'error',
      message:
        'The store config does not name the shop URL: sign the config again with the shop URL',
    };
    expect((await old.call('POST', '/v1/admin/connector/preview')).body.result).toEqual(refusal);
    expect(old.web.requests).toEqual([]);

    const linked = await setup({
      shopUrl: null,
      origins: ['https://blog.example'],
      linkOrigins: [SHOP],
    });
    await linked.call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    expect((await linked.call('POST', '/v1/admin/connector/preview')).body.result).toEqual(refusal);
    expect(linked.web.requests).toEqual([]);
  });

  it('a feed needs no shop URL, and its product links may be on a link origin', async () => {
    const feedUrl = 'https://feeds.example/products.xml';
    const feed = await setup({
      platform: 'google',
      origins: ['https://blog.example'],
      linkOrigins: [SHOP],
    });
    feed.web.route(feedUrl, {
      body: `<?xml version="1.0"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>ITEM-1</g:id><title>Item</title><link>${SHOP}/a</link><g:price>10.00 EUR</g:price><g:availability>in_stock</g:availability></item></channel></rss>`,
    });
    await feed.call('PUT', '/v1/admin/connector', { platform: 'google', url: feedUrl });
    const preview = await feed.call('POST', '/v1/admin/connector/preview');
    expect(preview.body.result.status).toBe('ok');
    expect(preview.body.result.diff.created).toEqual(['google:ITEM-1']);
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
    // The guard was given up: an admin sync may claim it at once.
    expect(await directory.claimCatalogSync(store.owner, 'admin', NOW, 60)).toBe(true);
  });

  it('a scheduled sync waits while another catalog sync of the store holds the guard', async () => {
    const { call, state, directory, store, relay } = await setup();
    await call('PUT', '/v1/admin/connector', {
      platform: 'shopify',
      url: SHOP,
      importPolicies: false,
    });
    await state.acquireLeases(HOLDER, NOW, 60);
    expect(await directory.claimCatalogSync(store.owner, 'other-instance', NOW, 3_600)).toBe(true);
    await call('POST', '/v1/admin/connector/enable');
    await expect
      .poll(async () => (await directory.connector(store.owner))?.lastStatus, { timeout: 5_000 })
      .toEqual({ status: 'error', message: 'Another catalog sync of this store is running' });
    expect(relay.published).toEqual([]);
  });
});

describe('server core review 2: connector preview on any instance (7.3, 7.4)', () => {
  it('an instance whose cache lacks the config reads it from the relay', async () => {
    const { call } = await setup({ cached: false });
    await call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    const preview = await call('POST', '/v1/admin/connector/preview');
    expect(preview.body.result.status).toBe('ok');
  });

  it('one preview per store at a time across instances, and none while a catalog sync holds it', async () => {
    const { call, callOther, relayPool, directory, store } = await setup({ cached: false });
    await call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    // The config read is slow, so the second preview arrives while the first runs.
    relayPool.relay(RELAY).delayMs = 100;
    const results = await Promise.all([
      call('POST', '/v1/admin/connector/preview'),
      callOther('POST', '/v1/admin/connector/preview'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body).toEqual({
      error: 'sync_running',
    });
    // The guard is free again once the preview ended.
    expect((await callOther('POST', '/v1/admin/connector/preview')).status).toBe(200);
    expect(await directory.claimCatalogSync(store.owner, 'elsewhere', NOW, 120)).toBe(true);
    expect((await call('POST', '/v1/admin/connector/preview')).body).toEqual({
      error: 'sync_running',
    });
    await directory.releaseCatalogSync(store.owner, 'elsewhere');
    expect((await call('POST', '/v1/admin/connector/preview')).status).toBe(200);
  });

  it("a preview is bounded by its own deadline, not the scheduled sync's", async () => {
    const { call, directory, store, relay, web, config } = await setup();
    await call('PUT', '/v1/admin/connector', { platform: 'shopify', url: SHOP });
    const record = await directory.store(store.owner);
    const connector: ConnectorRecord | undefined = await directory.connector(store.owner);
    if (record === undefined || connector === undefined) {
      throw new Error('store or connector missing');
    }
    const service = (deadlines: { syncDeadlineMs?: number; previewDeadlineMs?: number }) =>
      new ConnectorService({
        directory,
        holder: HOLDER,
        client: relay,
        configFor: () => config,
        limiter: new ShopRateLimiter(0),
        fetch: slowWeb(web, 100),
        pace: 1_000,
        ...deadlines,
      });
    const options = { dryRun: true, maxProducts: 1_000 };
    // A short sync deadline does not cut a preview, which has its own (two minutes by default).
    expect((await service({ syncDeadlineMs: 50 }).sync(record, connector, options)).status).toBe(
      'ok',
    );
    expect(
      await service({ syncDeadlineMs: 60_000, previewDeadlineMs: 50 }).sync(
        record,
        connector,
        options,
      ),
    ).toEqual({ status: 'error', message: 'The sync took longer than its deadline' });
  });
});

describe('server core review 2: the config read from the relay (7.3)', () => {
  it('takes the newest config, unless a deletion as new names its address', async () => {
    const store = syntheticStore();
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    const configAt = (createdAt: number, name: string) =>
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: store.assistant,
            origins: [SHOP],
            name,
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: store.catalogKey,
            createdAt,
          },
          store.ownerSecret,
        ),
        store.ownerSecret,
      );
    const deletionAt = (createdAt: number) =>
      finalizeEvent(
        {
          kind: 5,
          created_at: createdAt,
          tags: [['a', `30496:${store.owner}:askr`]],
          content: '',
        },
        store.ownerSecret,
      );
    expect(await readStoreConfig(pool, RELAY, store.owner, NOW)).toBeUndefined();
    relay.accept(configAt(NOW - 300, 'Old'));
    relay.accept(configAt(NOW - 100, 'New'));
    // Another author's config of the same address is not the store's.
    const other = syntheticStore();
    relay.accept(
      finalizeEvent(
        buildConfigEvent(
          {
            assistant: other.assistant,
            origins: [SHOP],
            name: 'Forged',
            language: 'en',
            currency: 'USD',
            source: { kind: 'catalog' },
            catalogKey: other.catalogKey,
            createdAt: NOW,
          },
          other.ownerSecret,
        ),
        other.ownerSecret,
      ),
    );
    relay.accept(deletionAt(NOW - 200));
    expect((await readStoreConfig(pool, RELAY, store.owner, NOW))?.name).toBe('New');
    relay.accept(deletionAt(NOW - 100));
    expect(await readStoreConfig(pool, RELAY, store.owner, NOW)).toBeUndefined();
    pool.unreachable.add(RELAY);
    expect(await readStoreConfig(pool, RELAY, store.owner, NOW)).toBeUndefined();
  });
});
