import type { ProductSource } from '@elisym/askr';
import { describe, expect, it, vi } from 'vitest';
import { nativeAddToCart, nativeCartPlatform, nativeCartVariantId } from '../src/native-cart';

const SHOP = 'https://shop.example';

function config(source: ProductSource) {
  return { source };
}

function respond(status: number) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
}

function requestOf(fetchImpl: ReturnType<typeof respond>): [string, RequestInit] {
  const [call] = fetchImpl.mock.calls;
  if (!call) {
    throw new Error('no request was made');
  }
  const [url, init] = call;
  if (typeof url !== 'string' || init === undefined) {
    throw new Error('unexpected request shape');
  }
  return [url, init];
}

describe('nativeCartPlatform', () => {
  it("is the connector platform on the connected shop's own origin", () => {
    expect(
      nativeCartPlatform(config({ kind: 'connector', platform: 'shopify', shopUrl: SHOP }), SHOP),
    ).toBe('shopify');
    expect(
      nativeCartPlatform(
        config({
          kind: 'connector',
          platform: 'woocommerce',
          shopUrl: 'https://www.shop.example/store',
        }),
        'https://www.shop.example',
      ),
    ).toBe('woocommerce');
  });

  it("is none on any origin but the shop's, even another configured one", () => {
    const shopify = config({ kind: 'connector', platform: 'shopify', shopUrl: SHOP });
    for (const origin of [
      'https://www.shop.example',
      'https://other.example',
      'http://shop.example',
      'null',
      undefined,
    ]) {
      expect(nativeCartPlatform(shopify, origin)).toBeUndefined();
    }
  });

  it('is none without a shop URL (an old two-value source) or without a connector cart', () => {
    expect(nativeCartPlatform(config({ kind: 'connector', platform: 'shopify' }), SHOP)).toBe(
      undefined,
    );
    expect(
      nativeCartPlatform(config({ kind: 'connector', platform: 'google', shopUrl: SHOP }), SHOP),
    ).toBe(undefined);
    for (const kind of ['paycore', 'catalog', 'admin'] as const) {
      expect(nativeCartPlatform(config({ kind }), SHOP)).toBeUndefined();
    }
  });
});

describe('nativeCartVariantId', () => {
  it('takes digits only and never a * variant', () => {
    expect(nativeCartVariantId({ id: '4242', values: ['S'] })).toBe('4242');
    for (const id of ['', 'v1', '12a', '-1', '1.5', ' 12', 'gid://shopify/ProductVariant/1']) {
      expect(nativeCartVariantId({ id, values: ['S'] })).toBeUndefined();
    }
    expect(nativeCartVariantId({ id: '4242', values: ['S', '*'] })).toBeUndefined();
  });
});

describe('nativeAddToCart', () => {
  it('Shopify: POST /cart/add.js on the host origin with one unit of the variant', async () => {
    const fetchImpl = respond(200);
    expect(await nativeAddToCart('shopify', SHOP, { id: '4242', values: [] }, fetchImpl)).toBe(
      true,
    );
    const [url, init] = requestOf(fetchImpl);
    expect(url).toBe('https://shop.example/cart/add.js');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ items: [{ id: 4242, quantity: 1 }] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('Shopify: a non-2xx answer (422 sold out, a redirect) fails', async () => {
    for (const status of [302, 404, 422, 500]) {
      expect(await nativeAddToCart('shopify', SHOP, { id: '1', values: [] }, respond(status))).toBe(
        false,
      );
    }
  });

  it('WooCommerce: a same-origin GET of the store root with ?add-to-cart=', async () => {
    const fetchImpl = respond(200);
    expect(await nativeAddToCart('woocommerce', SHOP, { id: '77', values: [] }, fetchImpl)).toBe(
      true,
    );
    const [url, init] = requestOf(fetchImpl);
    expect(url).toBe('https://shop.example/?add-to-cart=77');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeUndefined();
  });

  it('WooCommerce under a path: ?add-to-cart= on the shop path, not the origin root', async () => {
    const fetchImpl = respond(200);
    await nativeAddToCart('woocommerce', `${SHOP}/store`, { id: '77', values: [] }, fetchImpl);
    expect(requestOf(fetchImpl)[0]).toBe('https://shop.example/store/?add-to-cart=77');
  });

  it('Shopify: the cart is at the origin whatever path the shop URL has', async () => {
    const fetchImpl = respond(200);
    await nativeAddToCart('shopify', `${SHOP}/en`, { id: '1', values: [] }, fetchImpl);
    expect(requestOf(fetchImpl)[0]).toBe('https://shop.example/cart/add.js');
  });

  it('WooCommerce: 2xx and 3xx succeed, anything else fails', async () => {
    for (const [status, ok] of [
      [204, true],
      [302, true],
      [400, false],
      [503, false],
    ] as const) {
      expect(
        await nativeAddToCart('woocommerce', SHOP, { id: '77', values: [] }, respond(status)),
      ).toBe(ok);
    }
  });

  it('fails without a request for a non-numeric or * variant', async () => {
    const fetchImpl = respond(200);
    expect(await nativeAddToCart('shopify', SHOP, { id: 'abc', values: [] }, fetchImpl)).toBe(
      false,
    );
    expect(await nativeAddToCart('woocommerce', SHOP, { id: '77', values: ['*'] }, fetchImpl)).toBe(
      false,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a network error or timeout fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('offline')));
    expect(await nativeAddToCart('shopify', SHOP, { id: '1', values: [] }, fetchImpl)).toBe(false);
  });
});
