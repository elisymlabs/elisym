import { readFileSync } from 'node:fs';
import { ASKR_API_BASE } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import {
  APP_BRIDGE_URL,
  type AdminFile,
  SHOPIFY_API_KEY_PLACEHOLDER,
  SHOPIFY_INDEX,
  createShopifyPage,
  shopifyCsp,
} from '../src/admin/pages';
import { composeHandler } from '../src/gateway/routes';
import { WEBHOOK_PATH } from '../src/shopify/app';

const RELAY = 'wss://relay.askr.test';

function files(html: string): Map<string, AdminFile> {
  return new Map([
    [SHOPIFY_INDEX, { body: new TextEncoder().encode(html), type: 'text/html; charset=utf-8' }],
  ]);
}

const PAGE = `<script src="${APP_BRIDGE_URL}"></script><meta name="shopify-api-key" content="${SHOPIFY_API_KEY_PLACEHOLDER}" />`;

async function get(handler: ReturnType<typeof createShopifyPage>, path: string, method = 'GET') {
  const response = handler({
    request: new Request(`http://internal${path}`, { method }),
    clientAddress: '203.0.113.9',
  });
  return response;
}

describe('the embedded admin page (askr-shopify 5.1)', () => {
  const page = createShopifyPage(files(PAGE), RELAY, 'client-id"><script>');

  it('fills in the client id, safely, and lets only Shopify frame it', async () => {
    const response = await get(page, '/shopify/?shop=tea.myshopify.com&host=x');
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? '';
    expect(html).toContain('content="client-idscript"');
    expect(html).not.toContain(SHOPIFY_API_KEY_PLACEHOLDER);
    const csp = response?.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://admin.shopify.com https://tea.myshopify.com');
    expect(csp).toContain("script-src 'self' https://cdn.shopify.com");
    expect(csp).toContain(`connect-src 'self' ${RELAY}`);
    expect(response?.headers.get('x-frame-options')).toBeNull();
  });

  it('names no shop as a frame ancestor from a malformed parameter', () => {
    for (const shop of [null, 'evil.example', 'x.myshopify.com https://evil.example', '']) {
      expect(shopifyCsp(RELAY, shop).endsWith('frame-ancestors https://admin.shopify.com')).toBe(
        true,
      );
    }
  });

  it('serves any path under /shopify/, redirects /shopify and refuses writes', async () => {
    expect((await get(page, '/shopify/settings'))?.status).toBe(200);
    const redirect = await get(page, '/shopify?shop=tea.myshopify.com');
    expect(redirect?.status).toBe(308);
    expect(redirect?.headers.get('location')).toBe('/shopify/?shop=tea.myshopify.com');
    expect((await get(page, '/shopify/', 'POST'))?.status).toBe(405);
    expect(await get(page, '/admin/')).toBeUndefined();
    expect(await get(page, '/v1/shopify/time')).toBeUndefined();
  });

  it('refuses to start without the embedded page in the admin build', () => {
    expect(() => createShopifyPage(new Map(), RELAY, 'key')).toThrow(/shopify\/index\.html/);
  });

  it('answers 404 at /shopify/ when the app is off', async () => {
    const handler = composeHandler({
      publicBase: ASKR_API_BASE,
      admin: async () => undefined,
      storeDocs: async () => undefined,
      gateway: async () => new Response('gateway'),
    });
    for (const path of ['/shopify/', '/shopify']) {
      const response = await handler({
        request: new Request(`http://internal${path}`),
        clientAddress: '203.0.113.9',
      });
      expect(response.status).toBe(404);
    }
  });
});

describe('the Shopify app configuration matches the server (askr-shopify 4)', () => {
  const root = new URL('../../askr-shopify/', import.meta.url);
  const toml = readFileSync(new URL('shopify.app.toml', root), 'utf8');
  const liquid = readFileSync(
    new URL('extensions/askr-widget/blocks/app-embed.liquid', root),
    'utf8',
  );

  it('points Shopify at the server: the app page and the webhook path', () => {
    expect(toml).toContain(`application_url = "${ASKR_API_BASE}/shopify/"`);
    const uris = [...toml.matchAll(/uri = "([^"]+)"/g)].map((match) => match[1]);
    expect(uris).toEqual([`${ASKR_API_BASE}${WEBHOOK_PATH}`, `${ASKR_API_BASE}${WEBHOOK_PATH}`]);
    expect(toml).toContain('topics = ["app/uninstalled", "shop/update"]');
    expect(toml).toContain(
      'compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]',
    );
    expect(toml).toContain('scopes = "read_products,read_legal_policies"');
  });

  it('loads the widget with the store id the server writes to askr.store', () => {
    const server = readFileSync(new URL('../src/shopify/app.ts', import.meta.url), 'utf8');
    expect(server).toContain('namespace: "askr", key: "store"');
    expect(liquid).toContain('app.metafields.askr.store.value');
    expect(liquid).toContain(`src="${ASKR_API_BASE}/widget.js"`);
    expect(liquid).toContain('data-store="{{ askr_store | escape }}"');
    expect(liquid).toContain('"target": "body"');
  });
});
