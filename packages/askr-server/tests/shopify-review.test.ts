import { createHmac } from 'node:crypto';
import {
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  KIND_CONFIG_DELEGATION,
  type StoreConfig,
  buildConfigDelegation,
  buildConfigEvent,
  parseConfig,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { ShopRateLimiter } from '../src/connectors/http';
import { type ShopifyAppSource, syncConnector } from '../src/connectors/runner';
import { ConnectorService } from '../src/connectors/service';
import { bodyLimitOf } from '../src/gateway/http';
import { readShopPolicies, readShopProducts } from '../src/shopify/admin-catalog';
import { ShopifyApp } from '../src/shopify/app';
import { ShopifyClient, ShopifyRefused } from '../src/shopify/client';
import { configLanguage } from '../src/shopify/delegate-config';
import { ONBOARDING_TTL_SECS } from '../src/shopify/shops';
import { HOLDER, NOW, TIER } from './fixtures';
import {
  API_KEY,
  API_SECRET,
  BASE,
  PRIMARY,
  SHOP,
  fakeShop,
  fakeShopifyFetch,
  harness,
  memoryRelay,
  nip98,
} from './shopify-fixtures';

type Harness = Awaited<ReturnType<typeof harness>>;

const BULK = [
  {
    id: 'gid://shopify/Product/1',
    legacyResourceId: '1',
    title: 'Tea',
    handle: 'tea',
    onlineStoreUrl: `${PRIMARY}/products/tea`,
    options: [],
  },
  {
    id: 'gid://shopify/ProductVariant/2',
    legacyResourceId: '2',
    price: '3.00',
    availableForSale: true,
    selectedOptions: [],
    __parentId: 'gid://shopify/Product/1',
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n');

/** A public-page fetch that must never run: the Shopify app reads the Admin API only. */
const NO_PUBLIC_FETCH = {
  resolve: () => Promise.reject(new Error('the public shop was read')),
};

async function storedConfig(h: Harness, owner: string): Promise<StoreConfig> {
  const rows = await h.db.query<{ event: NostrEvent }>(
    `select event from store_events where owner = $1 and (event->>'kind')::int = $2
     order by (event->>'created_at')::bigint desc`,
    [owner, KIND_CONFIG],
  );
  const config = rows[0] === undefined ? undefined : parseConfig(rows[0].event, { owner });
  if (config === undefined) {
    throw new Error('no config');
  }
  return config;
}

function ownerSigned(
  ownerSecret: Uint8Array,
  config: StoreConfig,
  createdAt: number,
  shopUrl: string,
) {
  return finalizeEvent(
    buildConfigEvent(
      {
        assistant: config.assistant,
        origins: config.origins,
        name: config.name,
        language: config.language,
        currency: config.currency,
        source: { kind: 'connector', platform: 'shopify', shopUrl },
        catalogKey: config.catalogKey,
        createdAt,
      },
      ownerSecret,
    ),
    ownerSecret,
  );
}

async function begin(h: Harness, secret: Uint8Array, header?: string) {
  const body = { shop: SHOP };
  const authorization =
    header ??
    nip98({
      secret,
      method: 'POST',
      url: `${BASE}/v1/shopify/onboard/begin`,
      body: JSON.stringify(body),
      createdAt: h.clock.now,
    });
  return {
    header: authorization,
    response: await h.call('POST', '/v1/shopify/onboard/begin', {
      body,
      headers: { 'x-askr-owner-authorization': authorization },
    }),
  };
}

function signed(secret: Uint8Array, kind: number, tags: string[][], createdAt = NOW): NostrEvent {
  return finalizeEvent({ kind, created_at: createdAt, tags, content: '' }, secret);
}

describe('the Shopify app connector end to end (askr-shopify 3.5, 9)', () => {
  async function linked() {
    const h = await harness();
    const onboarded = await h.onboard();
    expect(await h.directory.setStatus(onboarded.owner, 'active', TIER.name)).toBe(true);
    h.shop.bulkJsonl = BULK;
    h.shop.policies = [{ type: 'SHIPPING_POLICY', title: 'Shipping', body: '<p>Free</p>' }];
    // What the publisher would have put on the relay once the store is active.
    for (const { event } of await h.db.query<{ event: NostrEvent }>(
      'select event from store_events where owner = $1',
      [onboarded.owner],
    )) {
      await h.relay.publish([], event);
    }
    return { h, ...onboarded };
  }

  it('previews through the Admin API, products and imported policies, never the public shop', async () => {
    const { h, owner } = await linked();
    const config = await storedConfig(h, owner);
    const service = new ConnectorService({
      directory: h.directory,
      holder: HOLDER,
      client: h.relay,
      configFor: () => config,
      limiter: new ShopRateLimiter(0),
      fetch: NO_PUBLIC_FETCH,
      shopifyApp: h.app,
    });
    const store = await h.directory.store(owner);
    const connector = await h.directory.connector(owner);
    if (store === undefined || connector === undefined) {
      throw new Error('missing');
    }
    const result = await service.sync(store, connector, { dryRun: true, maxProducts: 10 });
    expect(result).toMatchObject({ status: 'ok', policies: { set: ['shipping'] } });
    expect(result.status === 'ok' ? result.items?.map((item) => item.d) : []).toHaveLength(1);
  });

  it('syncs after a domain change while the config is D-signed, not when the owner signed it', async () => {
    const { h, owner, ownerSecret } = await linked();
    const config = await storedConfig(h, owner);
    await h.db.query(`update connectors set url = 'https://moved.example' where owner = $1`, [
      owner,
    ]);
    const store = await h.directory.store(owner);
    const connector = await h.directory.connector(owner);
    if (store === undefined || connector === undefined) {
      throw new Error('missing');
    }
    const serviceWith = (current: StoreConfig) =>
      new ConnectorService({
        directory: h.directory,
        holder: HOLDER,
        client: h.relay,
        configFor: () => current,
        limiter: new ShopRateLimiter(0),
        fetch: NO_PUBLIC_FETCH,
        shopifyApp: h.app,
      });
    const byDelegate = await serviceWith(config).sync(store, connector, {
      dryRun: true,
      maxProducts: 10,
    });
    expect(byDelegate.status).toBe('ok');
    const takenOver = parseConfig(ownerSigned(ownerSecret, config, NOW + 1, PRIMARY), { owner });
    if (takenOver === undefined) {
      throw new Error('no config');
    }
    const byOwner = await serviceWith(takenOver).sync(store, connector, {
      dryRun: true,
      maxProducts: 10,
    });
    expect(byOwner).toEqual({
      status: 'error',
      message: 'The store config names another shop URL than the connector',
    });
  });

  it('neither schedules nor syncs a Shopify app connector where the app is off', async () => {
    const { h, owner } = await linked();
    const config = await storedConfig(h, owner);
    const off = new ConnectorService({
      directory: h.directory,
      holder: HOLDER,
      client: h.relay,
      configFor: () => config,
      limiter: new ShopRateLimiter(0),
      fetch: NO_PUBLIC_FETCH,
    });
    const store = await h.directory.store(owner);
    const connector = await h.directory.connector(owner);
    if (store === undefined || connector === undefined) {
      throw new Error('missing');
    }
    expect(await off.sync(store, connector, { dryRun: true, maxProducts: 10 })).toEqual({
      status: 'error',
      message: 'The Shopify app is not on here',
    });
    const loads = vi.spyOn(h.directory, 'scheduledConnectors');
    await off.refresh();
    const on = new ConnectorService({
      directory: h.directory,
      holder: HOLDER,
      client: h.relay,
      configFor: () => config,
      limiter: new ShopRateLimiter(0),
      shopifyApp: h.app,
    });
    await on.refresh();
    off.stop();
    on.stop();
    expect(loads.mock.calls.map((call) => call[2])).toEqual([false, true]);
  });

  it('needs the shop currency on the Admin API path', async () => {
    const source: ShopifyAppSource = {
      readProducts: () => Promise.resolve({ products: [], malformed: 0 }),
      readPolicies: () => Promise.resolve([]),
    };
    const result = await syncConnector({
      platform: 'shopify',
      url: PRIMARY,
      owner: getPublicKey(generateSecretKey()),
      serverKey: generateSecretKey(),
      client: memoryRelay(),
      origins: [PRIMARY],
      shopifyApp: source,
      dryRun: true,
    });
    expect(result).toEqual({ status: 'error', message: 'The shop currency is unknown' });
  });
});

describe('onboarding checks (askr-shopify 3.3)', () => {
  async function begun() {
    const h = await harness();
    const ownerSecret = generateSecretKey();
    const { response } = await begin(h, ownerSecret);
    return {
      h,
      ownerSecret,
      catalogKey: String(response.body.catalogKey),
      delegate: String(response.body.delegate),
    };
  }

  const authTags = (key: string) => [
    ['d', key],
    ['p', key],
    ['mode', 'hosted'],
  ];

  it('refuses a grant dated too far ahead, an expiring one and a catalog key other than K', async () => {
    const { h, ownerSecret, catalogKey, delegate } = await begun();
    const grant = signed(ownerSecret, KIND_CONFIG_DELEGATION, authTags(delegate));
    const cases: [NostrEvent[], string][] = [
      [[signed(ownerSecret, KIND_CATALOG_AUTH, authTags(catalogKey), NOW + 601), grant], 'future'],
      [
        [
          signed(ownerSecret, KIND_CATALOG_AUTH, [
            ...authTags(catalogKey),
            ['expiration', `${NOW + 9999}`],
          ]),
          grant,
        ],
        'mode',
      ],
      [
        [
          signed(ownerSecret, KIND_CATALOG_AUTH, authTags(getPublicKey(generateSecretKey()))),
          grant,
        ],
        'catalog_auth',
      ],
      [
        [
          signed(ownerSecret, KIND_CATALOG_AUTH, [
            ['d', catalogKey],
            ['mode', 'hosted'],
          ]),
          grant,
        ],
        'catalog_auth',
      ],
    ];
    for (const [events, reason] of cases) {
      const refused = await h.call('POST', '/v1/shopify/onboard/finish', { body: { events } });
      expect(refused).toMatchObject({ status: 400, body: { error: 'bad_events', reason } });
    }
    const dated = signed(ownerSecret, KIND_CATALOG_AUTH, authTags(catalogKey), NOW + 600);
    const accepted = await h.call('POST', '/v1/shopify/onboard/finish', {
      body: { events: [dated, grant] },
    });
    expect(accepted.status).toBe(200);
  });

  it('answers 409 to the finish of an onboarding a later begin replaced', async () => {
    const { h, ownerSecret, catalogKey, delegate } = await begun();
    await begin(h, generateSecretKey());
    const replaced = await h.call('POST', '/v1/shopify/onboard/finish', {
      body: {
        events: [
          signed(ownerSecret, KIND_CATALOG_AUTH, authTags(catalogKey)),
          signed(ownerSecret, KIND_CONFIG_DELEGATION, authTags(delegate)),
        ],
      },
    });
    expect(replaced).toEqual({
      status: 409,
      body: { error: 'onboarding_replaced' },
      headers: replaced.headers,
    });
  });

  it('refuses settings between begin and finish', async () => {
    const { h } = await begun();
    for (const method of ['GET', 'PUT']) {
      const answer = await h.call(method, '/v1/shopify/settings', {
        ...(method === 'PUT' ? { body: {} } : {}),
      });
      expect(answer).toMatchObject({ status: 409, body: { error: 'shopify_onboarding' } });
    }
  });

  it('refuses begin for a moved owner key and a replayed authorization', async () => {
    const h = await harness();
    const moved = await h.directory.createStore(getPublicKey(generateSecretKey()), NOW);
    const movedSecret = generateSecretKey();
    // The key a store moved away from: its secret signs here.
    await h.db.query(
      `insert into store_moves (from_owner, to_owner, moved_at) values ($1, $2, $3)`,
      [getPublicKey(movedSecret), moved.owner, NOW],
    );
    expect((await begin(h, movedSecret)).response).toMatchObject({
      status: 409,
      body: { error: 'owner_taken' },
    });
    const secret = generateSecretKey();
    const first = await begin(h, secret);
    expect(first.response.status).toBe(200);
    const replay = await begin(h, secret, first.header);
    expect(replay.response).toMatchObject({ status: 401, body: { reason: 'replay' } });
  });

  it('refuses to recover from a store that is onboarding', async () => {
    const { h, ownerSecret } = await begun();
    const recover = await h.admin('POST', '/v1/admin/store/recover', generateSecretKey(), {
      from: getPublicKey(ownerSecret),
    });
    expect(recover).toEqual({ status: 409, body: { error: 'shopify_onboarding' } });
  });
});

describe('tokens through the client (askr-shopify 3.2)', () => {
  it('stores the rotated refresh token, keeps a fresh one and marks a dead one', async () => {
    const h = await harness();
    h.shop.expiresIn = 100;
    await h.call('GET', '/v1/shopify/store');
    const client = new ShopifyClient(
      { apiKey: API_KEY, apiSecret: API_SECRET },
      fakeShopifyFetch(h.shop),
    );
    const refresh = (token: string) => client.refresh(SHOP, token, h.clock.now);
    expect(await h.shops.accessToken(SHOP, h.clock.now, refresh)).toBe('shpat_2');
    expect(await h.shops.accessToken(SHOP, h.clock.now, refresh)).toBe('shpat_3');
    expect(h.shop.refreshTokensSent).toEqual(['shprt_1', 'shprt_2']);
    h.shop.expiresIn = 3600;
    expect(await h.shops.accessToken(SHOP, h.clock.now, refresh)).toBe('shpat_4');
    h.clock.now += 3000;
    expect(await h.shops.accessToken(SHOP, h.clock.now, refresh)).toBe('shpat_4');
    expect(h.shop.refreshes).toBe(3);
    h.clock.now += 400;
    h.shop.tokenStatus = 401;
    expect(await h.shops.accessToken(SHOP, h.clock.now, refresh)).toBeUndefined();
    expect((await h.shops.shop(SHOP))?.needsReauth).toBe(true);
  });

  it('keeps a transient refresh failure retryable', async () => {
    const h = await harness();
    h.shop.expiresIn = 100;
    await h.call('GET', '/v1/shopify/store');
    h.shop.tokenStatus = 503;
    const client = new ShopifyClient(
      { apiKey: API_KEY, apiSecret: API_SECRET },
      fakeShopifyFetch(h.shop),
    );
    await expect(
      h.shops.accessToken(SHOP, NOW, (token) => client.refresh(SHOP, token, NOW)),
    ).rejects.toThrow(/503/);
    expect((await h.shops.shop(SHOP))?.needsReauth).toBe(false);
  });

  it('tells a refused Admin call and a GraphQL error apart', async () => {
    const statuses = [401, 403];
    for (const status of statuses) {
      const client = new ShopifyClient(
        { apiKey: API_KEY, apiSecret: API_SECRET },
        async () => new Response('{}', { status }),
      );
      await expect(client.graphql(SHOP, 'token', '{ shop { id } }')).rejects.toBeInstanceOf(
        ShopifyRefused,
      );
    }
    const failing = new ShopifyClient(
      { apiKey: API_KEY, apiSecret: API_SECRET },
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'Throttled' }] }), { status: 200 }),
    );
    await expect(failing.graphql(SHOP, 'token', '{ shop { id } }')).rejects.toThrow(/Throttled/);
    const down = new ShopifyClient(
      { apiKey: API_KEY, apiSecret: API_SECRET },
      async () => new Response('', { status: 502 }),
    );
    const error = await down.graphql(SHOP, 'token', '{}').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ShopifyRefused);
    await expect(down.graphql('evil.example', 'token', '{}')).rejects.toThrow(/myshopify/);
  });
});

describe('settings during an assistant rotation (askr-shopify 3.4)', () => {
  it('names the next assistant, and the settings read opens a config sealed to it', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const next = await h.directory.beginRotation(owner);
    const saved = await h.call('PUT', '/v1/shopify/settings', {
      body: {
        origins: [PRIMARY],
        name: 'Tea House',
        language: 'en',
        currency: 'EUR',
        private: { notes: 'secret note' },
      },
    });
    expect(saved.status).toBe(200);
    expect((await storedConfig(h, owner)).assistant).toBe(next);
    const read = await h.call('GET', '/v1/shopify/settings');
    expect(read.body.private).toMatchObject({ notes: 'secret note' });
  });
});

describe('the lifecycle, more (askr-shopify 3.7)', () => {
  it('leaves a suspended Free store alone on uninstall', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.directory.activateFree(owner, TIER.name, NOW, { perDay: 10, maxActive: 10 });
    await h.db.query(`update stores set status = 'suspended' where owner = $1`, [owner]);
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    expect(await h.directory.statusOf(owner)).toEqual({ status: 'suspended', tier: TIER.name });
    expect(await h.directory.planSourceOf(owner)).toBe('free');
  });

  it('never works a finished delivery again, even after its hold', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    await h.call('GET', '/v1/shopify/store');
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
    h.clock.now = NOW + 3600;
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
  });

  it('ignores shop/update for an uninstalled shop and keeps only handled topics', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.webhook('app/uninstalled', {});
    h.clock.now = NOW + 1;
    await h.webhook('shop/update', { domain: 'new-tea.example' });
    await h.webhook('products/update', { id: 1 });
    await h.webhook('customers/data_request', {});
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.url).toBe(PRIMARY);
    // Worked off and closed: never claimed again after its hold.
    const open = await h.db.query(
      `select 1 from shopify_webhooks where topic = 'shop/update' and done_at is null`,
    );
    expect(open).toEqual([]);
    h.clock.now = NOW + 3600;
    await h.app.runJobs();
    expect(h.logs.filter((line) => line.includes('failed'))).toEqual([]);
    const topics = await h.db.query<{ topic: string }>(
      'select topic from shopify_webhooks order by received_at',
    );
    expect(topics.map((row) => row.topic)).toEqual(['app/uninstalled', 'shop/update']);
  });

  it('writes the store metafield on open when it is missing or wrong, else leaves it', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    expect(h.shop.metafieldWrites).toBe(1);
    await h.call('GET', '/v1/shopify/store');
    expect(h.shop.metafieldWrites).toBe(1);
    h.shop.metafield = null;
    await h.call('GET', '/v1/shopify/store');
    expect(h.shop.metafieldWrites).toBe(2);
    h.shop.metafield = 'npub1wrong';
    await h.call('GET', '/v1/shopify/store');
    expect(h.shop.metafieldWrites).toBe(3);
    expect(h.shop.metafield).not.toBe('npub1wrong');
    expect(owner).toHaveLength(64);
  });

  it('deletes a store D manages despite a forged owner config on the relay, its owner rows too', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const config = await storedConfig(h, owner);
    const real = ownerSigned(generateSecretKey(), config, NOW + 5, PRIMARY);
    await h.relay.publish([], { ...real, pubkey: owner });
    await h.db.query('insert into store_totals (owner, conversations) values ($1, 3)', [owner]);
    await h.webhook('app/uninstalled', {});
    h.clock.now = NOW + 1;
    await h.webhook('shop/redact', {});
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeUndefined();
    expect(await h.db.query('select 1 from store_totals where owner = $1', [owner])).toEqual([]);
  });
});

describe('the Admin API reads, edges (askr-shopify 3.5)', () => {
  const client = (shop = fakeShop()) =>
    new ShopifyClient({ apiKey: API_KEY, apiSecret: API_SECRET }, fakeShopifyFetch(shop));

  it('reads an empty shop as no products and stops at the deadline', async () => {
    expect(await readShopProducts(client(), SHOP, 'token')).toEqual({ products: [], malformed: 0 });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      readShopProducts(client(), SHOP, 'token', { signal: aborted.signal }),
    ).rejects.toThrow(/too long/);
  });

  it('skips a policy whose body is empty', async () => {
    const shop = fakeShop();
    shop.policies = [
      { type: 'REFUND_POLICY', title: 'Refunds', body: '<p> </p>' },
      { type: 'PRIVACY_POLICY', title: 'Privacy', body: 'Kept' },
    ];
    expect(
      (await readShopPolicies(client(shop), SHOP, 'token')).map((policy) => policy.input.slug),
    ).toEqual(['privacy']);
  });

  it('caps a language at 35 characters', () => {
    const long = `en-${'abcdefgh-'.repeat(3)}abcdefgh`;
    expect(long.length).toBeGreaterThan(35);
    expect(configLanguage(long)).toBe('en');
    expect(configLanguage(long.slice(0, 35).replace(/-$/u, ''))).not.toBe('en');
  });
});

describe('pruning grants (askr-shopify 2)', () => {
  it('replaces an older published grant of the same delegate', async () => {
    const h = await harness();
    const { owner, ownerSecret, delegate } = await h.onboard();
    await h.db.query('update store_events set published = true where owner = $1', [owner]);
    const newer = finalizeEvent(
      buildConfigDelegation({ key: delegate, createdAt: NOW + 1 }),
      ownerSecret,
    );
    expect(await h.directory.addEvents(owner, [newer])).toEqual({ ok: true });
    await h.db.query('update store_events set published = true where owner = $1', [owner]);
    const another = finalizeEvent(
      buildConfigDelegation({ key: getPublicKey(generateSecretKey()), createdAt: NOW + 2 }),
      ownerSecret,
    );
    expect(await h.directory.addEvents(owner, [another])).toEqual({ ok: true });
    const grants = await h.db.query<{ created_at: number }>(
      `select (event->>'created_at')::bigint as created_at from store_events
       where owner = $1 and (event->>'kind')::int = $2 order by 1`,
      [owner, KIND_CONFIG_DELEGATION],
    );
    expect(grants.map((row) => row.created_at)).toEqual([NOW + 1, NOW + 2]);
  });
});

describe('job runs (askr-shopify 3.2)', () => {
  it('runs one at a time per process, and once more for a kick during a run', async () => {
    const h = await harness();
    let running = 0;
    let most = 0;
    let runs = 0;
    const release: (() => void)[] = [];
    vi.spyOn(h.app, 'runJobs').mockImplementation(async () => {
      runs += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
    });
    h.app.kickJobs();
    h.app.kickJobs();
    h.app.kickJobs();
    expect(runs).toBe(1);
    release.shift()?.();
    await vi.waitFor(() => expect(runs).toBe(2));
    release.shift()?.();
    await vi.waitFor(() => expect(running).toBe(0));
    expect(runs).toBe(2);
    expect(most).toBe(1);
  });
});

describe('expiry and webhooks in production wiring (askr-shopify 3.1, 3.2)', () => {
  it('never deletes an onboarding finished between the candidate read and its delete', async () => {
    const h = await harness();
    const ownerSecret = generateSecretKey();
    const owner = getPublicKey(ownerSecret);
    expect((await begin(h, ownerSecret)).response.status).toBe(200);
    h.clock.now = NOW + ONBOARDING_TTL_SECS + 1;
    const original = h.db.transaction.bind(h.db);
    vi.spyOn(h.db, 'transaction').mockImplementationOnce(async (work) => {
      // `finish` completing meanwhile: the store leaves onboarding.
      await h.db.query('update stores set shopify_onboarding_until = null where owner = $1', [
        owner,
      ]);
      return original(work);
    });
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeDefined();
  });

  it('kicks the single-flight job run for each recorded delivery', async () => {
    const h = await harness();
    await h.onboard();
    const app = new ShopifyApp({
      secrets: { apiKey: API_KEY, apiSecret: API_SECRET, partnerToken: 'partner' },
      db: h.db,
      shops: h.shops,
      directory: h.directory,
      client: new ShopifyClient(
        { apiKey: API_KEY, apiSecret: API_SECRET },
        fakeShopifyFetch(h.shop),
      ),
      syncClient: h.relay,
      publicBase: BASE,
      storesChanged: () => undefined,
      now: () => h.clock.now,
    });
    let running = 0;
    let most = 0;
    let runs = 0;
    const release: (() => void)[] = [];
    vi.spyOn(app, 'runJobs').mockImplementation(async () => {
      runs += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
    });
    for (let index = 0; index < 3; index += 1) {
      const raw = JSON.stringify({ domain: `shop-${index}.example`, myshopify_domain: SHOP });
      const response = await app.handle({
        request: new Request('http://internal/v1/shopify/webhooks', {
          method: 'POST',
          headers: {
            'x-shopify-hmac-sha256': createHmac('sha256', API_SECRET).update(raw).digest('base64'),
            'x-shopify-shop-domain': SHOP,
            'x-shopify-topic': 'shop/update',
            'x-shopify-webhook-id': `delivery-${index}`,
          },
          body: raw,
        }),
        clientAddress: '203.0.113.9',
      });
      expect(response?.status).toBe(200);
    }
    expect(runs).toBe(1);
    release.shift()?.();
    await vi.waitFor(() => expect(runs).toBe(2));
    release.shift()?.();
    await vi.waitFor(() => expect(running).toBe(0));
    expect(most).toBe(1);
    expect(runs).toBe(2);
  });
});

describe('deepsec round (askr-shopify phase 2)', () => {
  it('drops a signed body naming another shop than its header', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.webhook('app/uninstalled', { myshopify_domain: 'other.myshopify.com' });
    await h.webhook('shop/redact', { shop_domain: 'other.myshopify.com' });
    await h.webhook('app/uninstalled', { myshopify_domain: undefined, shop_domain: undefined });
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
    expect(await h.db.query('select 1 from shopify_webhooks')).toEqual([]);
    await h.webhook('shop/redact', { shop_domain: SHOP });
    expect(await h.db.query('select topic from shopify_webhooks')).toEqual([
      { topic: 'shop/redact' },
    ]);
  });

  it('gives Shopify webhooks and session-token calls their own body caps', () => {
    expect(bodyLimitOf('POST', '/v1/shopify/webhooks', undefined)).toBe(1024 * 1024);
    expect(bodyLimitOf('PUT', '/v1/shopify/settings', 'Bearer a.b.c')).toBe(256 * 1024);
    expect(bodyLimitOf('PUT', '/v1/shopify/settings', undefined)).toBe(16 * 1024);
    expect(bodyLimitOf('PUT', '/v1/shopify/settings', 'Nostr abc')).toBe(16 * 1024);
    expect(bodyLimitOf('POST', '/v1/session', undefined)).toBe(16 * 1024);
  });

  it('keeps a Shopify app connector out of the admin connector routes', async () => {
    const h = await harness();
    const { owner, ownerSecret } = await h.onboard();
    // Once the merchant took the store over: the app's connector still follows the shop.
    await h.db.query('update stores set delegate_active = false where owner = $1', [owner]);
    const put = await h.admin('PUT', '/v1/admin/connector', ownerSecret, {
      platform: 'shopify',
      url: 'https://evil.example',
    });
    expect(put).toEqual({ status: 409, body: { error: 'shopify_managed' } });
    const removed = await h.admin('DELETE', '/v1/admin/connector', ownerSecret);
    expect(removed).toEqual({ status: 409, body: { error: 'shopify_managed' } });
    expect((await h.directory.connector(owner))?.url).toBe(PRIMARY);
  });

  it('reads a bulk result only from a public https host', async () => {
    const asked: string[] = [];
    const client = new ShopifyClient({ apiKey: API_KEY, apiSecret: API_SECRET }, async (url) => {
      asked.push(url);
      return new Response('', { status: 200 });
    });
    for (const url of [
      'http://storage.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://metadata.internal/x',
      'https://user:pass@storage.googleapis.com/x',
    ]) {
      await expect(client.bulkResult(url, 10)).rejects.toThrow(/public https/);
    }
    expect(asked).toEqual([]);
    await client.bulkResult('https://storage.googleapis.com/shopify/result.jsonl', 10);
    expect(asked).toEqual(['https://storage.googleapis.com/shopify/result.jsonl']);
  });
});

describe('redact racing a reinstall (deepsec round 2)', () => {
  it('keeps a store D manages when the shop installs the app again while deletions go out', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    h.clock.now = NOW + 1;
    await h.webhook('shop/redact', { shop_domain: SHOP });
    const publish = h.relay.publish.bind(h.relay);
    let reinstalled = false;
    vi.spyOn(h.relay, 'publish').mockImplementation(async (relays, event) => {
      if (!reinstalled) {
        reinstalled = true;
        await h.call('GET', '/v1/shopify/store');
      }
      return publish(relays, event);
    });
    await h.app.runJobs();
    expect(reinstalled).toBe(true);
    expect(await h.directory.store(owner)).toBeDefined();
    expect((await h.shops.shop(SHOP))?.uninstalledAt).toBeNull();
    expect(h.logs.some((line) => line.includes('installed the app again during its redact'))).toBe(
      true,
    );
  });

  it('keeps the link of a store its owner manages when the shop reinstalls meanwhile', async () => {
    const h = await harness();
    const { owner, ownerSecret } = await h.onboard();
    const config = await storedConfig(h, owner);
    await h.relay.publish([], ownerSigned(ownerSecret, config, NOW + 1, PRIMARY));
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    h.clock.now = NOW + 2;
    await h.webhook('shop/redact', { shop_domain: SHOP });
    const query = h.relay.query.bind(h.relay);
    vi.spyOn(h.relay, 'query').mockImplementationOnce(async (relays, filter) => {
      await h.call('GET', '/v1/shopify/store');
      return query(relays, filter);
    });
    await h.app.runJobs();
    expect((await h.shops.shop(SHOP))?.owner).toBe(owner);
    expect((await h.shops.delegation(owner))?.delegate).not.toBeNull();
  });
});

describe('webhook topics bound to their bodies (deepsec round 3)', () => {
  it('drops a body under another topic or delivery id, and a body of the wrong shape', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const send = async (topic: string, body: Record<string, unknown>, id: string) => {
      const raw = JSON.stringify(body);
      const response = await h.app.handle({
        request: new Request('http://internal/v1/shopify/webhooks', {
          method: 'POST',
          headers: {
            'x-shopify-hmac-sha256': createHmac('sha256', API_SECRET).update(raw).digest('base64'),
            'x-shopify-shop-domain': SHOP,
            'x-shopify-topic': topic,
            'x-shopify-webhook-id': id,
          },
          body: raw,
        }),
        clientAddress: '203.0.113.9',
      });
      return response?.status;
    };
    const update = { myshopify_domain: SHOP, domain: 'new-tea.example', updated_at: 'x' };
    expect(await send('shop/update', update, 'one')).toBe(200);
    // The same signed body again, as an uninstall under a fresh delivery id.
    expect(await send('app/uninstalled', update, 'two')).toBe(200);
    // A redact body passed off as an uninstall, and a shop body passed off as a redact.
    expect(await send('app/uninstalled', { shop_domain: SHOP, shop_id: 7 }, 'three')).toBe(200);
    expect(await send('shop/redact', { ...update, shop_id: 7 }, 'four')).toBe(200);
    const recorded = await h.db.query<{ topic: string }>(
      'select topic from shopify_webhooks order by id',
    );
    expect(recorded).toEqual([{ topic: 'shop/update' }, { topic: 'app/uninstalled' }]);
    // The uninstall under a replayed body: Shopify still takes the shop's token, so nothing changes.
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
    expect((await h.shops.shop(SHOP))?.hasTokens).toBe(true);
    expect(h.logs.some((line) => line.includes('still installed: ignored'))).toBe(true);
    // shop/update read the domain from Shopify, not from the body.
    expect((await h.directory.connector(owner))?.url).toBe(PRIMARY);
  });
});

describe('redact of a shop with no store (deepsec round 4)', () => {
  it('forgets an uninstalled shop that never onboarded, and nothing once it is installed again', async () => {
    const h = await harness();
    await h.call('GET', '/v1/shopify/store');
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    await h.call('GET', '/v1/shopify/store');
    h.clock.now = NOW + 1;
    await h.webhook('shop/redact', {});
    await h.app.runJobs();
    expect(await h.shops.shop(SHOP)).toBeDefined();
    await h.webhook('app/uninstalled', {});
    h.clock.now = NOW + 2;
    await h.app.runJobs();
    await h.db.query(
      'update shopify_webhooks set done_at = null, claimed_until = 0 where topic = $1',
      ['shop/redact'],
    );
    await h.app.runJobs();
    expect(await h.shops.shop(SHOP)).toBeUndefined();
  });
});

describe('uninstalls confirmed with Shopify (review of the deepsec fixes)', () => {
  it('works off a genuine uninstall whose body equals an earlier shop/update', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const body = { myshopify_domain: SHOP, domain: 'tea.example', updated_at: 'same' };
    await h.webhook('shop/update', body, { id: 'update' });
    await h.webhook('app/uninstalled', body, { id: 'uninstall' });
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(false);
    expect((await h.shops.shop(SHOP))?.uninstalledAt).toBe(NOW);
  });

  it('works off a second uninstall with the same body after a reinstall', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const body = { myshopify_domain: SHOP, domain: 'tea.example', updated_at: 'same' };
    await h.webhook('app/uninstalled', body, { id: 'first' });
    await h.app.runJobs();
    await h.call('GET', '/v1/shopify/store');
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
    h.clock.now = NOW + 10;
    await h.webhook('app/uninstalled', body, { id: 'second' });
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(false);
    expect((await h.shops.shop(SHOP))?.uninstalledAt).toBe(NOW + 10);
  });

  it('keeps an ownerless shop row that reinstalls while its redact runs', async () => {
    const h = await harness();
    await h.call('GET', '/v1/shopify/store');
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    h.clock.now = NOW + 1;
    await h.webhook('shop/redact', {});
    const query = h.db.query.bind(h.db);
    let raced = false;
    vi.spyOn(h.db, 'query').mockImplementation(async (sql, params) => {
      if (!raced && sql.includes('owner is null and uninstalled_at is not null')) {
        raced = true;
        await h.call('GET', '/v1/shopify/store');
      }
      return query(sql, params);
    });
    await h.app.runJobs();
    expect(raced).toBe(true);
    expect(await h.shops.shop(SHOP)).toMatchObject({ hasTokens: true, uninstalledAt: null });
  });

  it('refuses IPv6 and .local bulk hosts', async () => {
    const client = new ShopifyClient({ apiKey: API_KEY, apiSecret: API_SECRET }, async () => {
      throw new Error('fetched');
    });
    await expect(client.bulkResult('https://[::ffff:127.0.0.1]/x', 10)).rejects.toThrow(
      /public https/,
    );
    await expect(client.bulkResult('https://printer.local/x', 10)).rejects.toThrow(/public https/);
  });
});

describe('confirmation edges (review of the deepsec fixes, round 2)', () => {
  it('retries an uninstall Shopify could not confirm, and changes nothing meanwhile', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.webhook('app/uninstalled', {}, { genuine: false });
    h.shop.graphqlStatus = 503;
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
    expect((await h.shops.shop(SHOP))?.uninstalledAt).toBeNull();
    const open = await h.db.query('select 1 from shopify_webhooks where done_at is null');
    expect(open).toHaveLength(1);
    h.shop.graphqlStatus = undefined;
    h.shop.installed = false;
    h.clock.now = NOW + 600;
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(false);
  });

  it('takes a shop with no usable token as uninstalled', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.db.query('update shopify_shops set needs_reauth = true where shop = $1', [SHOP]);
    await h.webhook('app/uninstalled', {}, { genuine: false });
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.enabled).toBe(false);
  });

  it('signs no new config for a shop/update that left the domain alone', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const before = await h.db.query('select id from store_events where owner = $1', [owner]);
    h.clock.now = NOW + 5;
    await h.webhook('shop/update', {});
    await h.app.runJobs();
    const after = await h.db.query('select id from store_events where owner = $1', [owner]);
    expect(after).toEqual(before);
  });

  it('keeps a shop/update open until a token is usable again, then moves the domain', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.db.query('update shopify_shops set needs_reauth = true where shop = $1', [SHOP]);
    h.shop.primaryHost = 'new-tea.example';
    await h.webhook('shop/update', {});
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.url).toBe(PRIMARY);
    await h.call('GET', '/v1/shopify/store');
    h.clock.now = NOW + 600;
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.url).toBe('https://new-tea.example');
  });
});
