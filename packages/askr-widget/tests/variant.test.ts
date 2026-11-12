import type { CatalogItem } from '@elisym/askr';
import { describe, expect, it, vi } from 'vitest';
import { cartButton, hostAddToCartHook, pickState, selectorsFor } from '../src/variant';

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    author: 'a'.repeat(64),
    d: 'shopify:42',
    address: `30402:${'a'.repeat(64)}:shopify:42`,
    title: 'Tee',
    description: '',
    price: { amount: '20', currency: 'USD' },
    priceFrom: false,
    images: [],
    topics: [],
    links: [],
    attrs: [],
    options: [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Color', values: ['Red', 'Blue'] },
    ],
    variants: [
      { id: '101', price: '20', available: true, values: ['S', 'Red'] },
      { id: '102', price: '22', available: false, values: ['M', 'Red'] },
      { id: '103', price: '20', available: true, values: ['S', 'Blue'] },
    ],
    visibility: 'on-sale',
    hasAccept: false,
    createdAt: 1,
    ...overrides,
  };
}

const HOOK = { hook: () => undefined, native: undefined };

describe('selectorsFor', () => {
  it('shows one selector per option', () => {
    expect(selectorsFor(item()).map((option) => option.name)).toEqual(['Size', 'Color']);
  });

  it('hides selectors for exactly one variant without *', () => {
    const single = item({
      options: [{ name: 'Title', values: ['Default Title'] }],
      variants: [{ id: 'only', price: '20', available: true, values: ['Default Title'] }],
    });
    expect(selectorsFor(single)).toEqual([]);
  });

  it('keeps selectors for one variant with a * value', () => {
    const any = item({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [{ id: 'any', price: '20', available: true, values: ['*'] }],
    });
    expect(selectorsFor(any)).toHaveLength(1);
  });
});

describe('the add-to-cart hook', () => {
  it('is disabled until every selector is set, and gets options for a partial pick', () => {
    const state = pickState(item(), { Size: 'S' });
    const button = cartButton(item({ sku: 'TEE' }), state, HOOK);
    expect(button).toEqual({
      kind: 'hook',
      enabled: false,
      detail: { d: 'shopify:42', sku: 'TEE', options: { Size: 'S' } },
    });
  });

  it('gets the variant only when the pick determines one', () => {
    const button = cartButton(item(), pickState(item(), { Size: 'S', Color: 'Blue' }), HOOK);
    expect(button).toEqual({
      kind: 'hook',
      enabled: true,
      detail: { d: 'shopify:42', variant: '103', options: { Size: 'S', Color: 'Blue' } },
    });
  });

  it('a pick matching a * variant determines none, and the hook stays enabled with options', () => {
    const any = item({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [{ id: 'any', price: '20', available: true, values: ['*'] }],
    });
    const button = cartButton(any, pickState(any, { Size: 'M' }), HOOK);
    expect(button).toEqual({
      kind: 'hook',
      enabled: true,
      detail: { d: 'shopify:42', options: { Size: 'M' } },
    });
  });

  it('ignores values a selector does not offer', () => {
    expect(pickState(item(), { Size: 'XXL' }).options).toBeUndefined();
  });

  it('a listing with no selectors gets its single variant and no options', () => {
    const single = item({
      options: [{ name: 'Title', values: ['Default Title'] }],
      variants: [{ id: 'only', price: '20', available: true, values: ['Default Title'] }],
    });
    expect(cartButton(single, pickState(single, {}), HOOK)).toEqual({
      kind: 'hook',
      enabled: true,
      detail: { d: 'shopify:42', variant: 'only' },
    });
  });
});

describe('sold out and precedence', () => {
  it('a sold-out listing or an unavailable determined variant shows a label, not a button', () => {
    expect(cartButton(item(), pickState(item({ visibility: 'sold-out' }), {}), HOOK).kind).toBe(
      'sold-out',
    );
    expect(cartButton(item(), pickState(item(), { Size: 'M', Color: 'Red' }), HOOK).kind).toBe(
      'sold-out',
    );
  });

  it('hook first, then native (product page until a variant is determined), else no button', () => {
    const state = pickState(item(), { Size: 'S' });
    expect(cartButton(item(), state, { hook: undefined, native: 'shopify' })).toEqual({
      kind: 'native',
      platform: 'shopify',
    });
    const determined = pickState(item(), { Size: 'S', Color: 'Red' });
    expect(cartButton(item(), determined, { hook: undefined, native: 'woocommerce' })).toEqual({
      kind: 'native',
      platform: 'woocommerce',
      variant: item().variants[0],
    });
    expect(cartButton(item(), determined, { hook: () => undefined, native: 'shopify' }).kind).toBe(
      'hook',
    );
    expect(cartButton(item(), state, { hook: undefined, native: undefined })).toEqual({
      kind: 'none',
    });
  });

  it('native never carries a * variant or a non-numeric id: the card opens the product page', () => {
    const any = item({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [{ id: '201', price: '20', available: true, values: ['*'] }],
    });
    expect(
      cartButton(any, pickState(any, { Size: 'M' }), { hook: undefined, native: 'woocommerce' }),
    ).toEqual({
      kind: 'native',
      platform: 'woocommerce',
    });
    const single = item({
      options: [{ name: 'Title', values: ['Default Title'] }],
      variants: [{ id: 'gid-7', price: '20', available: true, values: ['Default Title'] }],
    });
    expect(
      cartButton(single, pickState(single, {}), { hook: undefined, native: 'shopify' }),
    ).toEqual({
      kind: 'native',
      platform: 'shopify',
    });
  });

  it('a single variant without selectors is native at once', () => {
    const single = item({
      options: [{ name: 'Title', values: ['Default Title'] }],
      variants: [{ id: '301', price: '20', available: true, values: ['Default Title'] }],
    });
    expect(
      cartButton(single, pickState(single, {}), { hook: undefined, native: 'shopify' }),
    ).toMatchObject({
      kind: 'native',
      variant: { id: '301' },
    });
  });

  it('a pick matching several variants determines none', () => {
    const shared = item({
      options: [
        { name: 'Size', values: ['S'] },
        { name: 'Color', values: ['Red'] },
      ],
      variants: [
        { id: '401', price: '20', available: true, values: ['S', 'Red'] },
        { id: '402', price: '20', available: true, values: ['S', '*'] },
      ],
    });
    expect(
      cartButton(shared, pickState(shared, { Size: 'S', Color: 'Red' }), {
        hook: undefined,
        native: 'shopify',
      }),
    ).toEqual({ kind: 'native', platform: 'shopify' });
  });

  it('reads window.Askr.onAddToCart at call time and calls it on its namespace', () => {
    const scope: Record<string, unknown> = {};
    expect(hostAddToCartHook(scope)).toBeUndefined();
    const onAddToCart = vi.fn();
    scope.Askr = { onAddToCart };
    hostAddToCartHook(scope)?.({ d: 'x' });
    expect(onAddToCart).toHaveBeenCalledWith({ d: 'x' });
    scope.Askr = { onAddToCart: 'not a function' };
    expect(hostAddToCartHook(scope)).toBeUndefined();
  });
});
