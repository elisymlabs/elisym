import {
  CONFIG_D_TAG,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  KIND_CONFIG_DELEGATION,
  KIND_POLICY,
  buildCatalogItemEvent,
  buildConfigEvent,
  configAddress,
  parseConfig,
} from '@elisym/askr';
import { KIND_DELETION, KIND_PRODUCT } from '@elisym/commerce';
import type { NostrEvent } from 'nostr-tools';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { composeHandler } from '../src/gateway/routes';
import { ONBOARDING_TTL_SECS } from '../src/shopify/shops';
import { computeStats } from '../src/stats';
import { HOLDER, NOW, TIER } from './fixtures';
import { BASE, PRIMARY, SHOP, harness, nip98, tokenFor } from './shopify-fixtures';

async function storedEvents(db: Awaited<ReturnType<typeof harness>>['db'], owner: string) {
  const rows = await db.query<{ event: NostrEvent }>(
    'select event from store_events where owner = $1',
    [owner],
  );
  return rows.map((row) => row.event);
}

function ownerConfig(
  ownerSecret: Uint8Array,
  assistant: string,
  catalogKey: string,
  createdAt: number,
) {
  return finalizeEvent(
    buildConfigEvent(
      {
        assistant,
        origins: [PRIMARY],
        name: 'Taken over',
        language: 'en',
        currency: 'EUR',
        source: { kind: 'connector', platform: 'shopify', shopUrl: PRIMARY },
        catalogKey,
        createdAt,
      },
      ownerSecret,
    ),
    ownerSecret,
  );
}

describe('the Shopify app off (askr-shopify 9.5)', () => {
  it('answers 404 on every /v1/shopify path when the app is not configured', async () => {
    const handler = composeHandler({
      publicBase: BASE,
      admin: async () => undefined,
      storeDocs: async () => undefined,
      gateway: async () => new Response('gateway', { status: 200 }),
    });
    for (const path of ['/v1/shopify/time', '/v1/shopify/webhooks', '/v1/shopify/store']) {
      const response = await handler({
        request: new Request(`http://internal${path}`, { method: 'POST' }),
        clientAddress: '203.0.113.9',
      });
      expect(response.status).toBe(404);
    }
    const other = await handler({
      request: new Request('http://internal/v1/other'),
      clientAddress: '203.0.113.9',
    });
    expect(await other.text()).toBe('gateway');
  });
});

describe('session-token routes (askr-shopify 3.2, 5.2)', () => {
  it('refuses a bad session token with the App Bridge retry header', async () => {
    const h = await harness();
    const bad = await h.call('GET', '/v1/shopify/time', {
      token: tokenFor(SHOP, NOW, { aud: 'other' }),
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('x-shopify-retry-invalid-session-request')).toBe('1');
    expect((await h.call('GET', '/v1/shopify/time')).body).toEqual({ now: NOW });
  });

  it('exchanges a token on the first open only and answers a shop not onboarded yet', async () => {
    const h = await harness();
    const first = await h.call('GET', '/v1/shopify/store');
    expect(first.body).toEqual({ shop: SHOP, onboarded: false, store: null });
    await h.call('GET', '/v1/shopify/store');
    expect(h.shop.exchanges).toBe(1);
    expect((await h.shops.shop(SHOP))?.hasTokens).toBe(true);
  });

  it('refreshes an access token about to expire, once, under the row lock', async () => {
    const h = await harness();
    h.shop.expiresIn = 100;
    await h.call('GET', '/v1/shopify/store');
    const refresh = (token: string) => {
      expect(token).toBe('shprt_1');
      return Promise.resolve({
        accessToken: 'shpat_new',
        refreshToken: 'shprt_new',
        expiresAt: NOW + 3600,
        scopes: '',
      });
    };
    expect(await h.shops.accessToken(SHOP, NOW, refresh)).toBe('shpat_new');
    expect(await h.shops.accessToken(SHOP, NOW, () => Promise.reject(new Error('unused')))).toBe(
      'shpat_new',
    );
  });

  it('marks needs_reauth on a dead refresh token and exchanges again on the next open', async () => {
    const h = await harness();
    h.shop.expiresIn = 100;
    await h.call('GET', '/v1/shopify/store');
    h.shop.tokenStatus = 401;
    const { ShopifyRefused } = await import('../src/shopify/client');
    expect(
      await h.shops.accessToken(SHOP, NOW, () => Promise.reject(new ShopifyRefused('dead', 401))),
    ).toBeUndefined();
    expect((await h.shops.shop(SHOP))?.needsReauth).toBe(true);
    h.shop.tokenStatus = undefined;
    await h.call('GET', '/v1/shopify/store');
    expect(h.shop.exchanges).toBe(2);
    expect((await h.shops.shop(SHOP))?.needsReauth).toBe(false);
  });
});

describe('onboarding (askr-shopify 3.3)', () => {
  it('creates a pending store with D in charge, the shop config and an enabled connector', async () => {
    const h = await harness();
    const { owner, catalogKey, delegate } = await h.onboard();
    const store = await h.directory.store(owner);
    expect(store?.status).toBe('pending');
    expect(store?.catalogKey).toBe(catalogKey);
    expect(await h.shops.delegation(owner)).toEqual({ delegate, active: true, onboarding: false });
    const events = await storedEvents(h.db, owner);
    expect(events.map((event) => event.kind).sort()).toEqual(
      [KIND_CONFIG, KIND_CATALOG_AUTH, KIND_CONFIG_DELEGATION].sort(),
    );
    const configEvent = events.find((event) => event.kind === KIND_CONFIG);
    if (configEvent === undefined) {
      throw new Error('no config');
    }
    expect(configEvent.pubkey).toBe(delegate);
    const config = parseConfig(configEvent, { owner });
    expect(config).toMatchObject({
      owner,
      signer: delegate,
      origins: [PRIMARY, `https://${SHOP}`],
      name: 'Tea House',
      currency: 'EUR',
      language: 'de',
      catalogKey,
      assistant: store?.assistant,
      source: { kind: 'connector', platform: 'shopify', shopUrl: PRIMARY },
    });
    expect(await h.directory.connector(owner)).toMatchObject({
      platform: 'shopify',
      url: PRIMARY,
      currency: 'EUR',
      importPolicies: true,
      enabled: true,
      via: 'shopify_app',
    });
    // The shop's own origins, read by the server, are the store's sites (1.5).
    expect((await h.directory.originsHeld(owner)).map((held) => held.origin).sort()).toEqual(
      [PRIMARY, `https://${SHOP}`].sort(),
    );
    expect(h.shop.metafield).toBe(npubEncode(owner));
    const view = await h.call('GET', '/v1/shopify/store');
    expect(view.body).toMatchObject({
      onboarded: true,
      store: { owner, status: 'pending', delegation: { active: true, inCharge: true } },
    });
  });

  it('falls back to en when the locale cannot be read', async () => {
    const h = await harness();
    h.shop.locale = undefined;
    const { owner } = await h.onboard();
    const configEvent = (await storedEvents(h.db, owner)).find(
      (event) => event.kind === KIND_CONFIG,
    );
    expect(configEvent === undefined ? undefined : parseConfig(configEvent)?.language).toBe('en');
  });

  it('refuses begin without the owner proof, for another shop, or for a used owner key', async () => {
    const h = await harness();
    const ownerSecret = generateSecretKey();
    const body = { shop: SHOP };
    const unsigned = await h.call('POST', '/v1/shopify/onboard/begin', { body });
    expect(unsigned.status).toBe(401);
    const otherShop = await h.call('POST', '/v1/shopify/onboard/begin', {
      body: { shop: 'other.myshopify.com' },
      headers: {
        'x-askr-owner-authorization': nip98({
          secret: ownerSecret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify({ shop: 'other.myshopify.com' }),
          createdAt: NOW,
        }),
      },
    });
    expect(otherShop.status).toBe(400);
    // An owner key that already is a store.
    await h.directory.createStore(getPublicKey(ownerSecret), NOW);
    const used = await h.call('POST', '/v1/shopify/onboard/begin', {
      body,
      headers: {
        'x-askr-owner-authorization': nip98({
          secret: ownerSecret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify(body),
          createdAt: NOW,
        }),
      },
    });
    expect(used).toMatchObject({ status: 409, body: { error: 'owner_taken' } });
  });

  it('refuses begin and finish once the shop is onboarded', async () => {
    const h = await harness();
    await h.onboard();
    await expect(h.onboard()).rejects.toThrow(/begin answered 409/);
    const again = await h.call('POST', '/v1/shopify/onboard/finish', { body: { events: [] } });
    expect(again).toMatchObject({ status: 409, body: { error: 'onboarded' } });
  });

  it('lets a second begin replace the first unfinished store and keeps the tokens', async () => {
    const h = await harness();
    const begin = async (secret: Uint8Array) =>
      h.call('POST', '/v1/shopify/onboard/begin', {
        body: { shop: SHOP },
        headers: {
          'x-askr-owner-authorization': nip98({
            secret,
            method: 'POST',
            url: `${BASE}/v1/shopify/onboard/begin`,
            body: JSON.stringify({ shop: SHOP }),
            createdAt: NOW,
          }),
        },
      });
    const first = generateSecretKey();
    const second = generateSecretKey();
    expect((await begin(first)).status).toBe(200);
    expect((await begin(second)).status).toBe(200);
    expect(await h.directory.store(getPublicKey(first))).toBeUndefined();
    expect((await h.shops.shop(SHOP))?.owner).toBe(getPublicKey(second));
    expect(h.shop.exchanges).toBe(1);
  });

  it('refuses events that do not authorize exactly K and D', async () => {
    const h = await harness();
    const ownerSecret = generateSecretKey();
    const body = { shop: SHOP };
    const begun = await h.call('POST', '/v1/shopify/onboard/begin', {
      body,
      headers: {
        'x-askr-owner-authorization': nip98({
          secret: ownerSecret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify(body),
          createdAt: NOW,
        }),
      },
    });
    const catalogKey = String(begun.body.catalogKey);
    const auth = finalizeEvent(
      {
        kind: KIND_CATALOG_AUTH,
        created_at: NOW,
        tags: [
          ['d', catalogKey],
          ['mode', 'hosted'],
        ],
        content: '',
      },
      ownerSecret,
    );
    const otherGrant = finalizeEvent(
      {
        kind: KIND_CONFIG_DELEGATION,
        created_at: NOW,
        tags: [
          ['d', getPublicKey(generateSecretKey())],
          ['mode', 'hosted'],
        ],
        content: '',
      },
      ownerSecret,
    );
    const refused = await h.call('POST', '/v1/shopify/onboard/finish', {
      body: { events: [auth, otherGrant] },
    });
    expect(refused).toMatchObject({
      status: 400,
      body: { error: 'bad_events', reason: 'delegation' },
    });
    // Genuine but by another key: an onboarding a later begin replaced (409, plan 3.3).
    const strangerAuth = finalizeEvent({ ...auth, created_at: NOW + 1 }, generateSecretKey());
    const replaced = await h.call('POST', '/v1/shopify/onboard/finish', {
      body: { events: [strangerAuth, otherGrant] },
    });
    expect(replaced).toMatchObject({ status: 409, body: { error: 'onboarding_replaced' } });
    const forged = await h.call('POST', '/v1/shopify/onboard/finish', {
      body: { events: [{ ...auth, sig: strangerAuth.sig }, otherGrant] },
    });
    expect(forged).toMatchObject({ status: 400, body: { reason: 'signature' } });
  });

  it('keeps an unfinished store out of the admin API and deletes it once expired', async () => {
    const h = await harness();
    const ownerSecret = generateSecretKey();
    const owner = getPublicKey(ownerSecret);
    const body = { shop: SHOP };
    await h.call('POST', '/v1/shopify/onboard/begin', {
      body,
      headers: {
        'x-askr-owner-authorization': nip98({
          secret: ownerSecret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify(body),
          createdAt: NOW,
        }),
      },
    });
    for (const [method, path] of [
      ['GET', '/v1/admin/store'],
      ['POST', '/v1/admin/store'],
      ['POST', '/v1/admin/store/plan'],
      ['GET', '/v1/admin/store/events'],
    ] as const) {
      expect(await h.admin(method, path, ownerSecret, method === 'POST' ? {} : undefined)).toEqual({
        status: 409,
        body: { error: 'shopify_onboarding' },
      });
    }
    expect((await h.directory.list()).map((entry) => entry.owner)).not.toContain(owner);
    const counted = await computeStats(h.db, NOW, {
      days: 30,
      freeTier: undefined,
      prices: { kind: 'off' },
    });
    expect(counted.stores.total).toBe(0);
    expect(await h.directory.setStatus(owner, 'active', TIER.name)).toBe(false);
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeDefined();
    h.clock.now = NOW + ONBOARDING_TTL_SECS + 1;
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeUndefined();
    expect((await h.shops.shop(SHOP))?.owner).toBeNull();
    const late = await h.call('POST', '/v1/shopify/onboard/finish', { body: { events: [] } });
    expect(late).toMatchObject({ status: 409, body: { error: 'not_onboarding' } });
  });

  it('refuses finish after the onboarding expired before the job ran', async () => {
    const h = await harness();
    const ownerSecret = generateSecretKey();
    const body = { shop: SHOP };
    await h.call('POST', '/v1/shopify/onboard/begin', {
      body,
      headers: {
        'x-askr-owner-authorization': nip98({
          secret: ownerSecret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify(body),
          createdAt: NOW,
        }),
      },
    });
    h.clock.now = NOW + ONBOARDING_TTL_SECS + 1;
    const late = await h.call('POST', '/v1/shopify/onboard/finish', { body: { events: [] } });
    expect(late).toMatchObject({ status: 409, body: { error: 'onboarding_expired' } });
  });
});

describe('settings signed by D (askr-shopify 3.4)', () => {
  const settings = {
    origins: [PRIMARY, 'https://extra.example'],
    name: 'Tea House',
    language: 'en',
    currency: 'EUR',
    greeting: 'Hi',
    private: { instructions: 'Be brief' },
  };

  it('reads the current config with its private part', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const read = await h.call('GET', '/v1/shopify/settings');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      config: { owner, name: 'Tea House' },
      private: { voice: '', instructions: '', notes: '' },
      inCharge: true,
    });
  });

  it('saves a D config the server builds, dated after every stored one', async () => {
    const h = await harness();
    const { owner, delegate, catalogKey } = await h.onboard();
    expect((await h.call('PUT', '/v1/shopify/settings', { body: settings })).status).toBe(200);
    expect((await h.call('PUT', '/v1/shopify/settings', { body: settings })).status).toBe(200);
    const configs = (await storedEvents(h.db, owner))
      .filter((event) => event.kind === KIND_CONFIG)
      .sort((left, right) => left.created_at - right.created_at);
    // Pruning keeps the newest D config only (unpublished, replaced by a newer one still retried).
    expect(configs.map((event) => event.created_at)).toEqual([NOW + 2]);
    const [latest] = configs;
    const config = latest === undefined ? undefined : parseConfig(latest, { owner });
    expect(config).toMatchObject({ signer: delegate, catalogKey, greeting: 'Hi' });
    const read = await h.call('GET', '/v1/shopify/settings');
    expect(read.body.private).toMatchObject({ instructions: 'Be brief' });
    // A D-signed config proves no site: the extra origin is not on record (1.5).
    expect((await h.directory.originsHeld(owner)).map((held) => held.origin)).not.toContain(
      'https://extra.example',
    );
  });

  it('keeps the shop origin and refuses the server-owned fields', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    expect(
      (
        await h.call('PUT', '/v1/shopify/settings', {
          body: { ...settings, origins: ['https://extra.example'] },
        })
      ).status,
    ).toBe(200);
    const read = await h.call('GET', '/v1/shopify/settings');
    expect((read.body.config as { origins: string[] }).origins).toEqual([
      PRIMARY,
      'https://extra.example',
    ]);
    for (const extra of [
      { source: { kind: 'catalog' } },
      { catalogKey: owner },
      { assistant: owner },
      { policyKey: owner },
    ]) {
      expect(
        (await h.call('PUT', '/v1/shopify/settings', { body: { ...settings, ...extra } })).status,
      ).toBe(400);
    }
  });

  it('refuses past the rate limit and past the 60 s skew', async () => {
    const h = await harness();
    await h.onboard();
    for (let index = 0; index < 10; index += 1) {
      h.clock.now = NOW + 100 * (index + 1);
      expect((await h.call('PUT', '/v1/shopify/settings', { body: settings })).status).toBe(200);
    }
    const limited = await h.call('PUT', '/v1/shopify/settings', { body: settings });
    expect(limited).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  });

  it('refuses a config that would be dated more than 60 s ahead', async () => {
    const h = await harness();
    const { owner, delegate } = await h.onboard();
    const delegateSecret = await h.shops.delegateSecret(owner);
    const store = await h.directory.store(owner);
    if (delegateSecret === undefined || store === undefined) {
      throw new Error('missing');
    }
    expect(getPublicKey(delegateSecret)).toBe(delegate);
    const ahead = finalizeEvent(
      buildConfigEvent(
        {
          assistant: store.assistant,
          origins: [PRIMARY],
          name: 'Ahead',
          language: 'en',
          currency: 'EUR',
          source: { kind: 'connector', platform: 'shopify', shopUrl: PRIMARY },
          catalogKey: store.catalogKey,
          createdAt: NOW + 60,
        },
        delegateSecret,
      ),
      delegateSecret,
    );
    expect(await h.directory.addEvents(owner, [ahead])).toEqual({ ok: true });
    const refused = await h.call('PUT', '/v1/shopify/settings', { body: settings });
    expect(refused).toMatchObject({ status: 429 });
  });

  it('refuses D writes once the owner signed a newer config (owner_managed)', async () => {
    const h = await harness();
    const { owner, ownerSecret, catalogKey } = await h.onboard();
    const store = await h.directory.store(owner);
    h.clock.now = NOW + 10;
    await h.directory.addEvents(owner, [
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 10),
    ]);
    const refused = await h.call('PUT', '/v1/shopify/settings', { body: settings });
    expect(refused).toMatchObject({ status: 409, body: { error: 'owner_managed' } });
    expect((await h.call('GET', '/v1/shopify/settings')).body).toMatchObject({
      config: { name: 'Taken over', signer: owner },
      inCharge: false,
    });
  });
});

describe('store state with a delegate (askr-shopify 2, 1.5, 3.1)', () => {
  it('prunes per signer: an owner config does not replace a delegate config', async () => {
    const h = await harness();
    const { owner, ownerSecret, catalogKey } = await h.onboard();
    const store = await h.directory.store(owner);
    await h.db.query('update store_events set published = true where owner = $1', [owner]);
    await h.directory.addEvents(owner, [
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 5),
    ]);
    await h.db.query('update store_events set published = true where owner = $1', [owner]);
    await h.directory.addEvents(owner, [
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 6),
    ]);
    await h.db.query('update store_events set published = true where owner = $1', [owner]);
    // A newer one of either signer prunes only its own signer's older one.
    await h.directory.addEvents(owner, [
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 7),
    ]);
    await h.db.query('update store_events set published = true where owner = $1', [owner]);
    await h.directory.addEvents(owner, [
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 8),
    ]);
    const configs = (await storedEvents(h.db, owner)).filter((event) => event.kind === KIND_CONFIG);
    // The delegate's config stays; the owner's older ones go as newer owner ones replace them.
    expect(
      configs.filter((event) => event.pubkey !== owner).map((event) => event.created_at),
    ).toEqual([NOW]);
    const ownerTimes = configs
      .filter((event) => event.pubkey === owner)
      .map((event) => event.created_at)
      .sort();
    expect(ownerTimes).not.toContain(NOW + 5);
    expect(ownerTimes).toContain(NOW + 8);
  });

  it('refuses to recover a linked store and clears D when a store moves', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    const newSecret = generateSecretKey();
    const recover = await h.admin('POST', '/v1/admin/store/recover', newSecret, { from: owner });
    expect(recover).toEqual({ status: 409, body: { error: 'shopify_linked' } });
    const to = getPublicKey(generateSecretKey());
    expect(await h.directory.moveStore(owner, to, NOW, undefined)).toEqual({ ok: true });
    expect(await h.shops.delegation(to)).toEqual({
      delegate: null,
      active: false,
      onboarding: false,
    });
    expect(await h.shops.delegateSecret(to)).toBeUndefined();
    expect((await h.shops.shop(SHOP))?.needsRelink).toBe(true);
  });

  it('schedules a Shopify app connector only where the app is on', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    expect(await h.directory.setStatus(owner, 'active', TIER.name)).toBe(true);
    await h.db.query(
      `insert into leases (owner, holder, epoch, expires_at) values ($1, $2, 1, $3)`,
      [owner, HOLDER, NOW + 600],
    );
    expect(await h.directory.scheduledConnectors(HOLDER, NOW)).toEqual([]);
    expect(
      (await h.directory.scheduledConnectors(HOLDER, NOW, true)).map((entry) => entry.owner),
    ).toEqual([owner]);
  });
});

describe('the Admin API source (askr-shopify 3.5)', () => {
  it('reads products and policies of an installed shop, and none once uninstalled', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    h.shop.bulkJsonl = [
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
    h.shop.policies = [
      { type: 'REFUND_POLICY', title: 'Refunds', body: '<p>30 days</p>' },
      { type: 'CONTACT_INFORMATION', title: 'Contact', body: 'x' },
    ];
    const source = await h.app.sourceFor(owner);
    if (typeof source === 'string') {
      throw new Error(source);
    }
    const { products } = await source.readProducts(new AbortController().signal);
    expect(products.map((product) => product.variants.map((variant) => variant.id))).toEqual([
      ['2'],
    ]);
    expect(await source.readPolicies()).toEqual([
      { input: { slug: 'returns', title: 'Refunds', body: '30 days' }, truncated: false },
    ]);
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    expect(await h.app.sourceFor(owner)).toMatch(/uninstalled/);
    expect(await h.app.sourceFor(getPublicKey(generateSecretKey()))).toMatch(/not linked/);
  });
});

describe('webhooks and the lifecycle (askr-shopify 3.2, 3.7)', () => {
  it('refuses a bad signature, drops unknown shops and dedupes delivery ids', async () => {
    const h = await harness();
    await h.onboard();
    expect(await h.webhook('app/uninstalled', {}, { secret: 'wrong' })).toBe(401);
    expect(await h.webhook('app/uninstalled', {}, { shop: 'stranger.myshopify.com' })).toBe(200);
    expect(await h.webhook('customers/redact', {}, { shop: 'stranger.myshopify.com' })).toBe(200);
    expect(await h.webhook('shop/update', { domain: 'tea.example' }, { id: 'same' })).toBe(200);
    expect(await h.webhook('shop/update', { domain: 'tea.example' }, { id: 'same' })).toBe(200);
    const rows = await h.db.query<{ shop: string }>('select shop from shopify_webhooks');
    expect(rows).toEqual([{ shop: SHOP }]);
  });

  it('uninstall puts the store back to pending without a plan and stops the connector', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    await h.directory.activateFree(owner, TIER.name, NOW, { perDay: 10, maxActive: 10 });
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    expect(await h.directory.statusOf(owner)).toEqual({ status: 'pending', tier: null });
    expect(await h.directory.planSourceOf(owner)).toBeNull();
    expect((await h.directory.connector(owner))?.enabled).toBe(false);
    const shop = await h.shops.shop(SHOP);
    expect(shop).toMatchObject({ hasTokens: false, uninstalledAt: NOW });
    const autoActivated = await h.db.query<{ auto_activated_at: number | null }>(
      'select auto_activated_at from stores where owner = $1',
      [owner],
    );
    expect(autoActivated).toEqual([{ auto_activated_at: NOW }]);
    // Reinstall: new tokens, the connector on again, no new keys.
    const delegation = await h.shops.delegation(owner);
    await h.call('GET', '/v1/shopify/store');
    expect((await h.directory.connector(owner))?.enabled).toBe(true);
    expect(await h.shops.delegation(owner)).toEqual(delegation);
    expect((await h.shops.shop(SHOP))?.uninstalledAt).toBeNull();
  });

  it('uninstall leaves an operator or suspended store as it is', async () => {
    for (const status of ['operator', 'suspended'] as const) {
      const h = await harness();
      const { owner } = await h.onboard();
      await h.directory.setStatus(
        owner,
        status === 'suspended' ? 'suspended' : 'active',
        TIER.name,
      );
      await h.webhook('app/uninstalled', {});
      await h.app.runJobs();
      expect(await h.directory.statusOf(owner)).toEqual({
        status: status === 'suspended' ? 'suspended' : 'active',
        tier: TIER.name,
      });
    }
  });

  it('shop/update moves the connector, the primary origin and D config, keeping it enabled', async () => {
    const h = await harness();
    const { owner } = await h.onboard();
    h.clock.now = NOW + 5;
    h.shop.primaryHost = 'new-tea.example';
    await h.webhook('shop/update', {});
    await h.app.runJobs();
    const moved = 'https://new-tea.example';
    expect(await h.directory.connector(owner)).toMatchObject({ url: moved, enabled: true });
    expect((await h.shops.shop(SHOP))?.primaryOrigin).toBe(moved);
    const read = await h.call('GET', '/v1/shopify/settings');
    expect(read.body.config).toMatchObject({
      origins: [moved, `https://${SHOP}`],
      source: { shopUrl: moved },
      name: 'Tea House',
    });
    expect((await h.directory.originsHeld(owner)).map((held) => held.origin)).toContain(moved);
  });

  it('shop/update after a takeover leaves the owner config alone', async () => {
    const h = await harness();
    const { owner, ownerSecret, catalogKey } = await h.onboard();
    const store = await h.directory.store(owner);
    await h.directory.addEvents(owner, [
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 1),
    ]);
    h.clock.now = NOW + 5;
    h.shop.primaryHost = 'new-tea.example';
    await h.webhook('shop/update', {});
    await h.app.runJobs();
    expect((await h.directory.connector(owner))?.url).toBe('https://new-tea.example');
    const read = await h.call('GET', '/v1/shopify/settings');
    expect(read.body.config).toMatchObject({ signer: owner, origins: [PRIMARY] });
  });

  it('redact of a store D manages deletes its config, catalog and the store', async () => {
    const h = await harness();
    const { owner, delegate } = await h.onboard();
    const store = await h.directory.store(owner);
    if (store === undefined) {
      throw new Error('no store');
    }
    const listing = finalizeEvent(
      buildCatalogItemEvent({
        d: 'tea',
        title: 'Tea',
        price: { amount: '3', currency: 'EUR' },
        store: owner,
        createdAt: NOW,
      } as Parameters<typeof buildCatalogItemEvent>[0]),
      store.catalogSecretKey,
    );
    await h.relay.publish([], listing);
    // Not uninstalled yet: nothing happens.
    await h.webhook('shop/redact', {});
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeDefined();
    await h.webhook('app/uninstalled', {});
    await h.app.runJobs();
    h.relay.refuse = true;
    await h.webhook('shop/redact', {});
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeDefined();
    h.relay.refuse = false;
    h.clock.now = NOW + 600;
    await h.app.runJobs();
    expect(h.logs.filter((line) => line.includes('failed'))).toHaveLength(1);
    expect(await h.directory.store(owner)).toBeUndefined();
    expect(await h.shops.shop(SHOP)).toBeUndefined();
    const deletions = h.relay.events.filter((event) => event.kind === KIND_DELETION);
    expect(deletions.map((event) => [event.pubkey, event.tags])).toEqual([
      [delegate, [['a', configAddress(delegate)]]],
      [store.catalogKey, [['a', `${KIND_PRODUCT}:${store.catalogKey}:tea`]]],
    ]);
    expect(KIND_POLICY).toBe(30495);
  });

  it('redact of a store its owner took over only unlinks it, also when seen on the relay only', async () => {
    const h = await harness();
    const { owner, ownerSecret, catalogKey } = await h.onboard();
    const store = await h.directory.store(owner);
    await h.relay.publish(
      [],
      ownerConfig(ownerSecret, store?.assistant ?? '', catalogKey, NOW + 1),
    );
    await h.webhook('app/uninstalled', {});
    h.clock.now = NOW + 1;
    await h.webhook('shop/redact', {});
    await h.app.runJobs();
    expect(await h.directory.store(owner)).toBeDefined();
    expect(await h.shops.shop(SHOP)).toBeUndefined();
    expect(await h.shops.delegation(owner)).toEqual({
      delegate: null,
      active: false,
      onboarding: false,
    });
    expect(await h.directory.connector(owner)).toBeUndefined();
    expect(h.relay.events.filter((event) => event.kind === KIND_DELETION)).toEqual([]);
    expect(CONFIG_D_TAG).toBe('askr');
  });
});
