import { KIND_POLICY, parseCatalogItem, parsePolicy } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import type { TransportResponse } from '../../src/connectors/fetch-guard';
import {
  RequestBudgetError,
  ShopHttp,
  ShopRateLimiter,
  SyncDeadlineError,
} from '../../src/connectors/http';
import { type ConnectorSyncOptions, syncConnector } from '../../src/connectors/runner';
import { verifyOrigin } from '../../src/connectors/verification';
import { FakeWeb, NOW, type StoreKeys, fixture, fixtureJson, noSleep, storeKeys } from './helpers';

const SHOP = 'https://shop.example';
const PRODUCTS_URL = `${SHOP}/products.json?limit=250&page=1`;

function homeWithMeta(npub: string): string {
  return `<!doctype html><html><head><meta name="askr-verification" content="${npub}"></head><body>Shop</body></html>`;
}

function shopifyWeb(keys: StoreKeys): FakeWeb {
  return new FakeWeb()
    .route(`${SHOP}/`, {
      headers: { 'content-type': 'text/html' },
      body: homeWithMeta(keys.ownerNpub),
    })
    .route(PRODUCTS_URL, {
      headers: { 'content-type': 'application/json' },
      body: fixture('shopify-products.json'),
    })
    .json(`${SHOP}/meta.json`, fixtureJson('shopify-meta.json'))
    .route(`${SHOP}/policies/refund-policy.json`, {
      headers: { 'content-type': 'application/json' },
      body: fixture('shopify-refund-policy.json'),
    });
}

function options(keys: StoreKeys, web: FakeWeb, overrides: Partial<ConnectorSyncOptions> = {}) {
  return {
    platform: 'shopify' as const,
    url: SHOP,
    owner: keys.owner,
    serverKey: keys.serverKey,
    client: keys.relay,
    origins: [SHOP],
    fetch: web.deps(),
    limiter: new ShopRateLimiter(0),
    now: NOW,
    sleep: noSleep,
    pace: 1_000,
    ...overrides,
  };
}

describe('syncConnector: Shopify', () => {
  it('previews on a dry run, then publishes, then leaves an unchanged shop alone', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys);

    const preview = await syncConnector({ ...options(keys, web), dryRun: true });
    if (preview.status !== 'ok') {
      throw new Error(JSON.stringify(preview));
    }
    expect(preview.diff.created).toEqual([
      'shopify:6635123015735',
      'shopify:7420854370359',
      'shopify:7292464824400',
    ]);
    expect(preview.items).toHaveLength(3);
    expect(preview.truncated).toEqual(['shopify:7292464824400']);
    expect(preview.policies?.set).toEqual(['returns']);
    expect(keys.relay.published).toHaveLength(0);

    const first = await syncConnector(options(keys, web));
    expect(first.status).toBe('ok');
    expect(first.status === 'ok' && first.items).toBeUndefined();
    const listings = keys.relay.published.filter((event) => event.kind === 30402);
    expect(listings).toHaveLength(3);
    for (const event of listings) {
      expect(event.pubkey).toBe(keys.server);
      expect(parseCatalogItem(event, { role: 'catalog', now: NOW })).toBeDefined();
    }
    const policy = keys.relay.published.find((event) => event.kind === KIND_POLICY);
    expect(policy && parsePolicy(policy)).toMatchObject({
      slug: 'returns',
      title: 'Refund policy',
    });

    const publishedBefore = keys.relay.published.length;
    const second = await syncConnector(options(keys, web));
    expect(second.status === 'ok' && second.diff.unchanged).toHaveLength(3);
    expect(second.status === 'ok' && second.policies?.unchanged).toEqual(['returns']);
    expect(keys.relay.published).toHaveLength(publishedBefore);
  });

  it('removes an imported policy the shop no longer has, keeps it on a failed read', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys);
    await syncConnector(options(keys, web));

    web.route(`${SHOP}/policies/refund-policy.json`, { status: 500, body: 'oops' });
    const failed = await syncConnector(options(keys, web));
    expect(failed.status === 'ok' && failed.policyError).toMatch(/HTTP 500/u);
    expect(failed.status === 'ok' && failed.policies).toBeUndefined();

    web.route(`${SHOP}/policies/refund-policy.json`, {
      status: 404,
      body: '{"errors":"Not Found"}',
    });
    const removed = await syncConnector(options(keys, web));
    expect(removed.status === 'ok' && removed.policies?.removed).toEqual(['returns']);
    expect(keys.relay.published.at(-1)?.kind).toBe(5);
  });

  it('skips policies when the store opts out', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys);
    const result = await syncConnector({ ...options(keys, web), importPolicies: false });
    expect(result.status === 'ok' && result.policies).toBeUndefined();
    expect(web.urls.some((url) => url.includes('/policies/'))).toBe(false);
  });

  it('refuses a shop whose origin the config does not list, before any read', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys);
    const result = await syncConnector(options(keys, web, { origins: ['https://other.example'] }));
    expect(result).toEqual({
      status: 'verification_failed',
      failures: [{ origin: SHOP, reason: 'not_configured' }],
    });
    expect(web.urls).toEqual([]);
  });

  it('syncs nothing when the catalog is over the tier', async () => {
    const keys = storeKeys();
    const result = await syncConnector(options(keys, shopifyWeb(keys), { maxItems: 2 }));
    expect(result).toEqual({ status: 'error', message: "3 products, over the tier's 2" });
    expect(keys.relay.published).toHaveLength(0);
    const exact = await syncConnector(options(keys, shopifyWeb(keys), { maxItems: 3 }));
    expect(exact.status).toBe('ok');
  });

  it('fails verification without the meta tag, and reads no product', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys).route(`${SHOP}/`, { body: '<html><head></head></html>' });
    const result = await syncConnector(options(keys, web));
    expect(result).toEqual({
      status: 'verification_failed',
      failures: [{ origin: SHOP, reason: 'not_found' }],
    });
    expect(web.urls).not.toContain(PRODUCTS_URL);
    expect(keys.relay.published).toHaveLength(0);
  });

  it('fails verification for another owner npub', async () => {
    const keys = storeKeys();
    const other = storeKeys();
    const web = shopifyWeb(keys).route(`${SHOP}/`, { body: homeWithMeta(other.ownerNpub) });
    expect((await syncConnector(options(keys, web))).status).toBe('verification_failed');
  });

  it.each([401, 403, 404])('reports a closed source on HTTP %i', async (status) => {
    const keys = storeKeys();
    const web = shopifyWeb(keys).route(PRODUCTS_URL, { status, body: 'no' });
    expect(await syncConnector(options(keys, web))).toEqual({
      status: 'source_closed',
      url: PRODUCTS_URL,
      reason: `HTTP ${status}`,
      httpStatus: status,
    });
  });

  it('reports a closed source for a password page (redirect to HTML)', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys)
      .route(PRODUCTS_URL, { status: 302, headers: { location: '/password' } })
      .route(`${SHOP}/password`, {
        headers: { 'content-type': 'text/html' },
        body: '<html>locked</html>',
      });
    const result = await syncConnector(options(keys, web));
    expect(result.status === 'source_closed' && result.reason).toBe('not JSON');
  });

  it('publishes nothing when a later page fails (no partial catalog)', async () => {
    const keys = storeKeys();
    const full = {
      products: Array.from({ length: 250 }, (_unused, index) => ({
        id: index + 1,
        title: `P${index}`,
        handle: `p${index}`,
        variants: [{ id: index + 1000, price: '1.00', available: true }],
      })),
    };
    const web = shopifyWeb(keys)
      .json(PRODUCTS_URL, full)
      .route(`${SHOP}/products.json?limit=250&page=2`, { status: 502, body: 'bad gateway' });
    const result = await syncConnector(options(keys, web));
    expect(result).toEqual({
      status: 'error',
      message: `HTTP 502 from ${SHOP}/products.json?limit=250&page=2`,
    });
    expect(keys.relay.published).toHaveLength(0);
  });

  it('reports an error when the server key is not authorized', async () => {
    const keys = storeKeys();
    keys.relay.events.length = 0;
    const result = await syncConnector(options(keys, shopifyWeb(keys)));
    expect(result.status === 'error' && result.message).toMatch(/not authorized/u);
  });

  it('refuses a shop URL that the fetch guard refuses', async () => {
    const keys = storeKeys();
    const web = shopifyWeb(keys);
    expect(await syncConnector({ ...options(keys, web), url: 'http://shop.example' })).toEqual({
      status: 'error',
      message: 'not_https: Only https URLs are fetched',
    });
    web.hosts.set('shop.example', [{ address: '192.168.0.10', family: 4 }]);
    const blocked = await syncConnector(options(keys, web));
    // Verification cannot read the pages: nothing else is attempted.
    expect(blocked).toEqual({
      status: 'verification_failed',
      failures: [{ origin: SHOP, reason: 'fetch_failed' }],
    });
    expect(web.requests).toHaveLength(0);
  });
});

describe('verifyOrigin', () => {
  it('accepts /.well-known/askr naming the owner', async () => {
    const keys = storeKeys();
    const web = new FakeWeb().route(`${SHOP}/.well-known/askr`, { body: `${keys.ownerNpub}\n` });
    const http = new ShopHttp({ fetch: web.deps(), limiter: new ShopRateLimiter(0) });
    expect(await verifyOrigin(http, SHOP, keys.owner)).toBeUndefined();
    expect(web.urls).toEqual([`${SHOP}/.well-known/askr`]);
  });

  it('accepts the npub only as a whole token, not inside a longer one', async () => {
    const keys = storeKeys();
    for (const body of [`x${keys.ownerNpub}`, `${keys.ownerNpub}x`, `npub:${keys.ownerNpub}`]) {
      const web = new FakeWeb().route(`${SHOP}/.well-known/askr`, { body });
      const http = new ShopHttp({ fetch: web.deps(), limiter: new ShopRateLimiter(0) });
      expect(await verifyOrigin(http, SHOP, keys.owner)).toBe('not_found');
    }
    const web = new FakeWeb().route(`${SHOP}/.well-known/askr`, {
      body: `owner\t${keys.ownerNpub}\r\n`,
    });
    const http = new ShopHttp({ fetch: web.deps(), limiter: new ShopRateLimiter(0) });
    expect(await verifyOrigin(http, SHOP, keys.owner)).toBeUndefined();
  });

  it('does not accept a proof served after a redirect to another origin', async () => {
    const keys = storeKeys();
    const web = new FakeWeb()
      .route(`${SHOP}/`, { status: 301, headers: { location: 'https://elsewhere.example/' } })
      .route('https://elsewhere.example/', { body: homeWithMeta(keys.ownerNpub) });
    const http = new ShopHttp({ fetch: web.deps(), limiter: new ShopRateLimiter(0) });
    expect(await verifyOrigin(http, SHOP, keys.owner)).toBe('not_found');
  });

  it('accepts a same-origin redirect to the home page', async () => {
    const keys = storeKeys();
    const web = new FakeWeb()
      .route(`${SHOP}/`, { status: 302, headers: { location: '/en/' } })
      .route(`${SHOP}/en/`, { body: homeWithMeta(keys.ownerNpub) });
    const http = new ShopHttp({ fetch: web.deps(), limiter: new ShopRateLimiter(0) });
    expect(await verifyOrigin(http, SHOP, keys.owner)).toBeUndefined();
  });
});

describe('syncConnector: WooCommerce', () => {
  const BASE = `${SHOP}/store`;
  const API = `${BASE}/wp-json/wc/store/v1/products`;

  function wooWeb(keys: StoreKeys): FakeWeb {
    const products = fixtureJson('woo-products.json');
    const variations = fixtureJson('woo-variations.json');
    if (!Array.isArray(products) || typeof variations !== 'object' || variations === null) {
      throw new Error('fixtures');
    }
    const onShop = products.map((product: unknown) =>
      typeof product === 'object' && product !== null && 'permalink' in product
        ? { ...product, permalink: `${SHOP}/store/product/x/` }
        : product,
    );
    const byId = new Map(Object.entries(variations));
    // The batch answers only some ids; the rest are read one by one.
    const batchIds = ['502', '503', '504', '192', '4120', '4119', '4122', '4121'];
    return new FakeWeb()
      .route(`${SHOP}/`, { body: homeWithMeta(keys.ownerNpub) })
      .json(`${API}?per_page=100&page=1`, onShop)
      .json(`${API}?type=variation&include=${batchIds.join(',')}&per_page=100`, [
        byId.get('502'),
        byId.get('503'),
        byId.get('504'),
        byId.get('192'),
        byId.get('4120'),
        byId.get('4119'),
      ])
      .json(`${API}/4122`, byId.get('4122'))
      .route(`${API}/4121`, { status: 404, body: '{}' });
  }

  it('reads products and variations, batched with a per-variation fallback', async () => {
    const keys = storeKeys();
    const web = wooWeb(keys);
    const result = await syncConnector({
      ...options(keys, web),
      platform: 'woocommerce',
      url: `${BASE}/`,
      dryRun: true,
    });
    if (result.status !== 'ok') {
      throw new Error(JSON.stringify(result));
    }
    expect(result.diff.created).toEqual([
      'woocommerce:191',
      'woocommerce:375',
      'woocommerce:18734007022843',
    ]);
    // Variation 4121 is gone (404): its product is flagged truncated.
    expect(result.truncated).toEqual(['woocommerce:375']);
    const shoes = result.items?.find((item) => item.d === 'woocommerce:375');
    expect(shoes?.variants?.map((variant) => variant.id)).toEqual(['4120', '4119', '4122']);
    expect(shoes?.url).toBe(`${SHOP}/store/product/x/`);
    expect(web.urls.filter((url) => url.startsWith(`${API}/`))).toEqual([
      `${API}/4122`,
      `${API}/4121`,
    ]);
  });

  it('reports a closed Store API', async () => {
    const keys = storeKeys();
    const web = wooWeb(keys).route(`${API}?per_page=100&page=1`, {
      status: 401,
      body: '{"code":"rest_forbidden"}',
    });
    const result = await syncConnector({
      ...options(keys, web),
      platform: 'woocommerce',
      url: BASE,
    });
    expect(result.status).toBe('source_closed');
  });

  it('stops at the request budget instead of syncing a partial catalog', async () => {
    const keys = storeKeys();
    const web = wooWeb(keys);
    const result = await syncConnector({
      ...options(keys, web),
      platform: 'woocommerce',
      url: BASE,
      maxRequests: 3,
    });
    expect(result).toEqual({ status: 'error', message: 'Too many requests for one sync' });
    expect(keys.relay.published).toHaveLength(0);
  });
});

describe('syncConnector: Google feed', () => {
  const FEED = 'https://feeds.example/products.xml';

  function feed(links: string[]): string {
    const items = links
      .map(
        (link, index) =>
          `<item><g:id>ITEM-${index}</g:id><title>Item ${index}</title><link>${link}</link><g:price>10.00 EUR</g:price><g:availability>in_stock</g:availability></item>`,
      )
      .join('');
    return `<?xml version="1.0"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>${items}</channel></rss>`;
  }

  it('verifies every product link origin, not the feed host', async () => {
    const keys = storeKeys();
    const web = new FakeWeb()
      .route(FEED, {
        headers: { 'content-type': 'application/rss+xml' },
        body: feed([`${SHOP}/a`, `${SHOP}/b`]),
      })
      .route(`${SHOP}/.well-known/askr`, { body: keys.ownerNpub });
    const result = await syncConnector({ ...options(keys, web), platform: 'google', url: FEED });
    expect(result.status === 'ok' && result.diff.created).toEqual([
      'google:ITEM-0',
      'google:ITEM-1',
    ]);
    expect(web.urls).toEqual([FEED, `${SHOP}/.well-known/askr`]);
    const listing = keys.relay.published.find((event) => event.kind === 30402);
    expect(listing && parseCatalogItem(listing, { role: 'catalog', now: NOW })?.sku).toBe('ITEM-0');
  });

  it('fails when a product links to an origin the config does not list', async () => {
    const keys = storeKeys();
    const web = new FakeWeb()
      .route(FEED, { body: feed([`${SHOP}/a`, 'https://mirror.example/b']) })
      .route(`${SHOP}/.well-known/askr`, { body: keys.ownerNpub });
    const result = await syncConnector({ ...options(keys, web), platform: 'google', url: FEED });
    expect(result).toEqual({
      status: 'verification_failed',
      failures: [{ origin: 'https://mirror.example', reason: 'not_configured' }],
    });
    expect(keys.relay.published).toHaveLength(0);
  });

  it('fails when a configured link origin does not name the owner', async () => {
    const keys = storeKeys();
    const web = new FakeWeb().route(FEED, { body: feed([`${SHOP}/a`]) });
    const result = await syncConnector({ ...options(keys, web), platform: 'google', url: FEED });
    expect(result.status).toBe('verification_failed');
  });

  it('reports a feed that is not a feed as a closed source', async () => {
    const keys = storeKeys();
    const web = new FakeWeb().route(FEED, { body: '<html><body>login</body></html>' });
    const result = await syncConnector({ ...options(keys, web), platform: 'google', url: FEED });
    expect(result.status).toBe('source_closed');
  });

  it('refuses an oversize feed', async () => {
    const keys = storeKeys();
    const web = new FakeWeb().route(FEED, {
      headers: { 'content-length': String(64 * 1024 * 1024) },
      body: '<rss/>',
    });
    const result = await syncConnector({ ...options(keys, web), platform: 'google', url: FEED });
    expect(result.status === 'error' && result.message).toMatch(/^too_large/u);
  });
});

describe('ShopRateLimiter', () => {
  it('spaces requests to one origin and leaves other origins alone', async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const limiter = new ShopRateLimiter(
      500,
      () => clock,
      async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    );
    await limiter.acquire('https://a.example');
    await limiter.acquire('https://a.example');
    await limiter.acquire('https://b.example');
    await limiter.acquire('https://a.example');
    expect(waits).toEqual([500, 500]);
    clock += 10_000;
    await limiter.acquire('https://a.example');
    expect(waits).toEqual([500, 500]);
  });

  it('applies across syncs that share it', async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new ShopRateLimiter(
      1_000,
      () => clock,
      async (ms) => {
        waits.push(ms);
      },
    );
    const keys = storeKeys();
    const web = shopifyWeb(keys);
    await syncConnector({ ...options(keys, web), limiter, dryRun: true, importPolicies: false });
    // Every request but the first to the shop origin waited its turn.
    expect(waits.length).toBe(web.requests.length - 1);
  });
});

describe('a sync deadline', () => {
  function stallOn(web: FakeWeb, stalledUrl: string): FakeWeb {
    const deps = web.deps();
    const transport = deps.transport;
    web.deps = () => ({
      ...deps,
      transport: (request) =>
        request.url.toString() === stalledUrl || transport === undefined
          ? new Promise<TransportResponse>(() => undefined)
          : transport(request),
    });
    return web;
  }

  it('ends a sync stuck on a slow shop as an error long before the per-request cap', async () => {
    const keys = storeKeys();
    const web = stallOn(shopifyWeb(keys), PRODUCTS_URL);
    const started = Date.now();
    const result = await syncConnector(options(keys, web, { deadlineMs: 100 }));
    expect(result).toEqual({ status: 'error', message: 'The sync took longer than its deadline' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(keys.relay.published).toHaveLength(0);
  });

  it('a deadline during verification is an error, not a failed verification', async () => {
    const keys = storeKeys();
    const web = stallOn(stallOn(shopifyWeb(keys), `${SHOP}/.well-known/askr`), `${SHOP}/`);
    const result = await syncConnector(options(keys, web, { deadlineMs: 100 }));
    expect(result.status).toBe('error');
  });

  it('makes no request once the deadline passed', async () => {
    const web = new FakeWeb().route(`${SHOP}/a`, { body: 'a' });
    const deadline = new AbortController();
    const http = new ShopHttp({
      fetch: web.deps(),
      limiter: new ShopRateLimiter(0),
      signal: deadline.signal,
    });
    expect((await http.get(`${SHOP}/a`, { maxBytes: 100, timeoutMs: 1_000 })).body).toBe('a');
    deadline.abort();
    await expect(http.get(`${SHOP}/a`, { maxBytes: 100, timeoutMs: 1_000 })).rejects.toBeInstanceOf(
      SyncDeadlineError,
    );
    expect(web.requests).toHaveLength(1);
    // Nothing is counted or queued for a sync that is over.
    expect(http.requestCount).toBe(1);
  });

  it('defaults to a finite deadline', async () => {
    const { SYNC_DEADLINE_MS } = await import('../../src/connectors/constants');
    expect(SYNC_DEADLINE_MS).toBe(15 * 60 * 1000);
  });
});

describe('the request budget and rate limit', () => {
  const LIMIT = { maxBytes: 100, timeoutMs: 1_000 };

  it('allows exactly maxRequests requests', async () => {
    const web = new FakeWeb().route(`${SHOP}/a`, { body: 'a' });
    const http = new ShopHttp({
      fetch: web.deps(),
      limiter: new ShopRateLimiter(0),
      maxRequests: 2,
    });
    await http.get(`${SHOP}/a`, LIMIT);
    await http.get(`${SHOP}/a`, LIMIT);
    expect(http.requestCount).toBe(2);
    await expect(http.get(`${SHOP}/a`, LIMIT)).rejects.toBeInstanceOf(RequestBudgetError);
    expect(web.requests).toHaveLength(2);
  });

  it('counts every redirect hop as a request', async () => {
    const web = new FakeWeb()
      .route(`${SHOP}/1`, { status: 301, headers: { location: '/2' } })
      .route(`${SHOP}/2`, { status: 302, headers: { location: '/3' } })
      .route(`${SHOP}/3`, { body: 'end' });
    const enough = new ShopHttp({
      fetch: web.deps(),
      limiter: new ShopRateLimiter(0),
      maxRequests: 3,
    });
    expect((await enough.get(`${SHOP}/1`, LIMIT)).body).toBe('end');
    expect(enough.requestCount).toBe(3);
    const short = new ShopHttp({
      fetch: web.deps(),
      limiter: new ShopRateLimiter(0),
      maxRequests: 2,
    });
    await expect(short.get(`${SHOP}/1`, LIMIT)).rejects.toBeInstanceOf(RequestBudgetError);
  });

  it('spaces redirect hops by the per-shop limit of the hop origin', async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new ShopRateLimiter(
      500,
      () => clock,
      async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    );
    const web = new FakeWeb()
      .route(`${SHOP}/1`, { status: 301, headers: { location: '/2' } })
      .route(`${SHOP}/2`, { status: 302, headers: { location: 'https://cdn.example/3' } })
      .route('https://cdn.example/3', { body: 'end' });
    const http = new ShopHttp({ fetch: web.deps(), limiter });
    await http.get(`${SHOP}/1`, LIMIT);
    // The same-origin hop waited its turn; the hop to another origin did not.
    expect(waits).toEqual([500]);
    await limiter.acquire('https://cdn.example');
    expect(waits).toEqual([500, 500]);
  });

  it('a 404 on a later Shopify page is an error, not a closed source', async () => {
    const keys = storeKeys();
    const full = {
      products: Array.from({ length: 250 }, (_unused, index) => ({
        id: index + 1,
        title: `P${index}`,
        handle: `p${index}`,
        variants: [{ id: index + 1000, price: '1.00', available: true }],
      })),
    };
    const web = shopifyWeb(keys).json(PRODUCTS_URL, full);
    const result = await syncConnector(options(keys, web));
    expect(result).toEqual({
      status: 'error',
      message: `HTTP 404 from ${SHOP}/products.json?limit=250&page=2`,
    });
  });
});
