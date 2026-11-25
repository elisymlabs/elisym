import { createHmac } from 'node:crypto';
import { type SyncRelayClient, buildCatalogAuth, buildConfigDelegation } from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createAdminApi } from '../src/admin/api';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import { ShopRateLimiter } from '../src/connectors/http';
import { ConnectorService } from '../src/connectors/service';
import type { Db } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { ShopifyApp } from '../src/shopify/app';
import { ShopifyClient } from '../src/shopify/client';
import { ShopDirectory } from '../src/shopify/shops';
import { StoreDirectory } from '../src/state/stores';
import { HOLDER, MASTER_KEY, NOW, TIER } from './fixtures';
import { freshDb } from './pglite-db';

export const API_KEY = 'app-key';
export const API_SECRET = 'app-secret';
export const SHOP = 'tea.myshopify.com';
export const PRIMARY = 'https://tea.example';
export const BASE = 'https://api.askr.test';

/** An App Bridge session token signed like Shopify's. */
export function sessionToken(
  claims: Record<string, unknown>,
  secret: string = API_SECRET,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode(header)}.${encode(claims)}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function tokenFor(shop: string, now: number, overrides: Record<string, unknown> = {}) {
  return sessionToken({
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: API_KEY,
    sub: '42',
    exp: now + 60,
    nbf: now - 1,
    iat: now - 1,
    jti: Buffer.from(generateSecretKey()).toString('hex'),
    ...overrides,
  });
}

/** A NIP-98 authorization as the admin signs it. */
export function nip98(input: {
  secret: Uint8Array;
  method: string;
  url: string;
  body?: string;
  createdAt: number;
}): string {
  const event = finalizeEvent(
    {
      kind: KIND_HTTP_AUTH,
      created_at: input.createdAt,
      tags: [
        ['u', input.url],
        ['method', input.method],
        ...(input.body ? [['payload', sha256Hex(input.body)]] : []),
        ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
      ],
      content: '',
    },
    input.secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

/** A relay in memory: addressable events keep the newest per address. */
export function memoryRelay(): SyncRelayClient & { events: NostrEvent[]; refuse: boolean } {
  const events: NostrEvent[] = [];
  const address = (event: NostrEvent) =>
    `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === 'd')?.[1] ?? ''}`;
  const relay = {
    events,
    refuse: false,
    async query(_relays: readonly string[], filter: Filter) {
      return events.filter((event) => matchFilter(filter, event));
    },
    async publish(_relays: readonly string[], event: NostrEvent) {
      if (relay.refuse) {
        throw new Error('refused');
      }
      if (event.kind >= 30000 && event.kind < 40000) {
        const index = events.findIndex((stored) => address(stored) === address(event));
        if (index >= 0) {
          events.splice(index, 1);
        }
      }
      events.push(event);
    },
  };
  return relay;
}

/** What the fake Shopify answers, changeable by a test. */
export interface FakeShop {
  name: string;
  currency: string;
  primaryHost: string;
  locale: string | undefined;
  metafield: string | null;
  bulkJsonl: string;
  policies: { type: string; title: string; body: string }[];
  /** Status the token endpoint answers with instead of tokens. */
  tokenStatus?: number;
  exchanges: number;
  refreshes: number;
  /** The refresh tokens refresh calls sent, in order. */
  refreshTokensSent: string[];
  metafieldWrites: number;
  /** Token lifetime handed out, seconds. */
  expiresIn: number;
  /** Whether the app is installed: Shopify refuses the shop's tokens (401) once it is not. */
  installed: boolean;
  /** Status Admin GraphQL answers with instead of data (a Shopify outage). */
  graphqlStatus?: number;
}

export function fakeShop(): FakeShop {
  return {
    name: 'Tea House',
    currency: 'EUR',
    primaryHost: 'tea.example',
    locale: 'de',
    metafield: null,
    bulkJsonl: '',
    policies: [],
    exchanges: 0,
    refreshes: 0,
    refreshTokensSent: [],
    metafieldWrites: 0,
    expiresIn: 3600,
    installed: true,
  };
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Shopify's token endpoint, Admin GraphQL and bulk results, for one shop, in memory. */
export function fakeShopifyFetch(shop: FakeShop) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const body = typeof init.body === 'string' ? init.body : '';
    if (url.endsWith('/admin/oauth/access_token')) {
      const params = new URLSearchParams(body);
      if (shop.tokenStatus !== undefined) {
        return answer({ error: 'invalid_request' }, shop.tokenStatus);
      }
      if (params.get('grant_type') === 'refresh_token' && !shop.installed) {
        return answer({ error: 'invalid_request' }, 401);
      }
      if (params.get('grant_type') !== 'refresh_token') {
        shop.installed = true;
      }
      if (params.get('grant_type') === 'refresh_token') {
        shop.refreshes += 1;
        shop.refreshTokensSent.push(params.get('refresh_token') ?? '');
      } else {
        shop.exchanges += 1;
      }
      const serial = shop.exchanges + shop.refreshes;
      return answer({
        access_token: `shpat_${serial}`,
        refresh_token: `shprt_${serial}`,
        expires_in: shop.expiresIn,
        refresh_token_expires_in: 7_776_000,
        scope: 'read_products,read_legal_policies',
      });
    }
    if (url === 'https://bulk.example/result.jsonl') {
      return new Response(shop.bulkJsonl, { status: 200 });
    }
    if (!shop.installed) {
      return answer({ errors: 'Invalid API key or access token' }, 401);
    }
    if (shop.graphqlStatus !== undefined) {
      return answer({ errors: 'unavailable' }, shop.graphqlStatus);
    }
    const query = String(JSON.parse(body).query);
    if (query === '{ shop { id } }') {
      return answer({ data: { shop: { id: 'gid://shopify/Shop/7' } } });
    }
    if (query.includes('currentAppInstallation')) {
      return answer({
        data: {
          currentAppInstallation: {
            id: 'gid://shopify/AppInstallation/1',
            metafield: shop.metafield === null ? null : { value: shop.metafield },
          },
        },
      });
    }
    if (query.includes('metafieldsSet')) {
      shop.metafield = String(JSON.parse(body).variables.metafields[0].value);
      shop.metafieldWrites += 1;
      return answer({ data: { metafieldsSet: { userErrors: [] } } });
    }
    if (query.includes('shopLocales')) {
      return shop.locale === undefined
        ? answer({ errors: [{ message: 'Access denied' }] })
        : answer({ data: { shopLocales: [{ locale: shop.locale, primary: true }] } });
    }
    if (query.includes('shopPolicies')) {
      return answer({ data: { shop: { shopPolicies: shop.policies } } });
    }
    if (query.includes('primaryDomain')) {
      return answer({
        data: {
          shop: {
            id: 'gid://shopify/Shop/7',
            name: shop.name,
            currencyCode: shop.currency,
            myshopifyDomain: SHOP,
            primaryDomain: { url: `https://${shop.primaryHost}` },
          },
        },
      });
    }
    if (query.includes('bulkOperationRunQuery')) {
      return answer({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: 'gid://shopify/BulkOperation/1' },
            userErrors: [],
          },
        },
      });
    }
    if (query.includes('BulkOperation')) {
      return answer({
        data: {
          node: {
            status: 'COMPLETED',
            errorCode: null,
            url: shop.bulkJsonl === '' ? null : 'https://bulk.example/result.jsonl',
          },
        },
      });
    }
    return answer({ errors: [{ message: `unexpected query ${query.slice(0, 40)}` }] });
  };
}

export interface Harness {
  db: Db;
  directory: StoreDirectory;
  shops: ShopDirectory;
  relay: ReturnType<typeof memoryRelay>;
  shop: FakeShop;
  clock: { now: number };
  app: ShopifyApp;
  changed: string[];
  logs: string[];
  /** A call to the app's routes with a session token for `shop`. */
  call(
    method: string,
    path: string,
    options?: { body?: unknown; shop?: string; headers?: Record<string, string>; token?: string },
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>;
  /** A call to the standalone admin API as `secret`. */
  admin(
    method: string,
    path: string,
    secret: Uint8Array,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Onboard the shop with a fresh O; returns O and the keys the server made. */
  onboard(): Promise<{
    ownerSecret: Uint8Array;
    owner: string;
    catalogKey: string;
    delegate: string;
  }>;
  /** Deliver a signed webhook. */
  webhook(
    topic: string,
    payload: unknown,
    options?: { id?: string; shop?: string; secret?: string; genuine?: boolean },
  ): Promise<number>;
}

export async function harness(
  options: { freeTier?: { tier: string; perDay: number; maxActive: number } | null } = {},
): Promise<Harness> {
  const db = await freshDb();
  const vault = new KeyVault(MASTER_KEY);
  const directory = new StoreDirectory(db, vault);
  await directory.setTier(TIER);
  const shops = new ShopDirectory(db, vault);
  const relay = memoryRelay();
  const shop = fakeShop();
  const clock = { now: NOW };
  const changed: string[] = [];
  const logs: string[] = [];
  const app = new ShopifyApp({
    secrets: { apiKey: API_KEY, apiSecret: API_SECRET, partnerToken: 'partner' },
    db,
    shops,
    directory,
    client: new ShopifyClient({ apiKey: API_KEY, apiSecret: API_SECRET }, fakeShopifyFetch(shop)),
    syncClient: relay,
    publicBase: BASE,
    ...(options.freeTier === null
      ? {}
      : { freeTier: options.freeTier ?? { tier: TIER.name, perDay: 10, maxActive: 10 } }),
    storesChanged: () => changed.push('changed'),
    webhookRecorded: () => undefined,
    now: () => clock.now,
    log: (message) => logs.push(message),
  });
  const adminApi = createAdminApi({
    directory,
    publicBase: BASE,
    syncClient: relay,
    storeEventsChanged: () => changed.push('changed'),
    connectors: new ConnectorService({
      directory,
      holder: HOLDER,
      client: relay,
      configFor: () => undefined,
      limiter: new ShopRateLimiter(0),
    }),
    now: () => clock.now,
  });
  const call: Harness['call'] = async (method, path, options = {}) => {
    const text = options.body === undefined ? '' : JSON.stringify(options.body);
    const request = new Request(`http://internal:8787${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token ?? tokenFor(options.shop ?? SHOP, clock.now)}`,
        ...options.headers,
      },
      ...(text ? { body: text } : {}),
    });
    const response = await app.handle({ request, clientAddress: '203.0.113.9' });
    if (response === undefined) {
      throw new Error('not a Shopify path');
    }
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      headers: response.headers,
    };
  };
  const admin: Harness['admin'] = async (method, path, secret, body) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const request = new Request(`http://internal:8787${path}`, {
      method,
      headers: {
        authorization: nip98({
          secret,
          method,
          url: `${BASE}${path}`,
          body: text,
          createdAt: clock.now,
        }),
      },
      ...(text ? { body: text } : {}),
    });
    const response = await adminApi({ request, clientAddress: '203.0.113.9' });
    if (response === undefined) {
      throw new Error('not an admin path');
    }
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const onboard: Harness['onboard'] = async () => {
    const ownerSecret = generateSecretKey();
    const owner = getPublicKey(ownerSecret);
    const time = await call('GET', '/v1/shopify/time');
    const serverNow = Number(time.body.now);
    const beginBody = { shop: SHOP };
    const begun = await call('POST', '/v1/shopify/onboard/begin', {
      body: beginBody,
      headers: {
        'x-askr-owner-authorization': nip98({
          secret: ownerSecret,
          method: 'POST',
          url: `${BASE}/v1/shopify/onboard/begin`,
          body: JSON.stringify(beginBody),
          createdAt: serverNow,
        }),
      },
    });
    if (begun.status !== 200) {
      throw new Error(`begin answered ${begun.status} ${JSON.stringify(begun.body)}`);
    }
    const catalogKey = String(begun.body.catalogKey);
    const delegate = String(begun.body.delegate);
    const events = [
      finalizeEvent(
        buildCatalogAuth({ key: catalogKey, mode: 'hosted', createdAt: serverNow }),
        ownerSecret,
      ),
      finalizeEvent(buildConfigDelegation({ key: delegate, createdAt: serverNow }), ownerSecret),
    ];
    const finished = await call('POST', '/v1/shopify/onboard/finish', { body: { events } });
    if (finished.status !== 200) {
      throw new Error(`finish answered ${finished.status} ${JSON.stringify(finished.body)}`);
    }
    return { ownerSecret, owner, catalogKey, delegate };
  };
  let deliveries = 0;
  const webhook: Harness['webhook'] = async (topic, payload, options = {}) => {
    // Shopify's bodies name their shop in their topic's shape, and differ from one delivery to
    // the next; a test's own field wins.
    deliveries += 1;
    // A genuine uninstall: Shopify has revoked the shop's tokens by now.
    if (topic === 'app/uninstalled' && options.genuine !== false) {
      shop.installed = false;
    }
    const shopName = options.shop ?? SHOP;
    const shaped =
      topic === 'shop/redact'
        ? { shop_domain: shopName, shop_id: 7 }
        : { myshopify_domain: shopName, domain: 'tea.example', updated_at: deliveries };
    const raw = JSON.stringify(
      typeof payload === 'object' && payload !== null ? { ...shaped, ...payload } : payload,
    );
    const hmac = createHmac('sha256', options.secret ?? API_SECRET)
      .update(raw)
      .digest('base64');
    const request = new Request('http://internal:8787/v1/shopify/webhooks', {
      method: 'POST',
      headers: {
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-shop-domain': options.shop ?? SHOP,
        'x-shopify-topic': topic,
        'x-shopify-webhook-id': options.id ?? Buffer.from(generateSecretKey()).toString('hex'),
      },
      body: raw,
    });
    const response = await app.handle({ request, clientAddress: '203.0.113.9' });
    return response?.status ?? 0;
  };
  return {
    db,
    directory,
    shops,
    relay,
    shop,
    clock,
    app,
    changed,
    logs,
    call,
    admin,
    onboard,
    webhook,
  };
}
