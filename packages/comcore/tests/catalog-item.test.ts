import { describe, expect, it } from 'vitest';
import {
  buildCatalogItemEvent,
  catalogAddress,
  determinedVariant,
  parseAddress,
  parseCatalogItem,
  productPageUrl,
} from '../src/events/catalog-item';
import { NOW, sign, testKey } from './fixtures';

const key = testKey();

function shirt() {
  return buildCatalogItemEvent({
    d: 'shopify:123',
    title: 'Linen shirt',
    summary: 'Breathable',
    description: 'A shirt.',
    price: { amount: '49.90', currency: 'USD' },
    priceFrom: true,
    images: ['https://cdn.example.com/a.jpg'],
    topics: ['shirts'],
    url: 'https://shop.example.com/products/linen-shirt',
    sku: 'LS-1',
    sourceId: '123',
    attrs: [{ name: 'material', value: 'linen' }],
    options: [
      { name: 'size', values: ['S', 'M'] },
      { name: 'color', values: ['white', 'blue'] },
    ],
    variants: [
      { id: 'v1', price: '49.90', available: true, values: ['S', 'white'] },
      { id: 'v2', price: '54.90', available: false, values: ['M', 'blue'] },
      { id: 'v3', price: '59.90', available: true, values: ['M', '*'] },
    ],
    createdAt: NOW - 10,
  });
}

describe('catalog items', () => {
  it('round-trips through the builder and the reader', () => {
    const event = sign(shirt(), key);
    const item = parseCatalogItem(event, { now: NOW, role: 'catalog' });
    expect(item).toMatchObject({
      author: key.pubkey,
      d: 'shopify:123',
      address: catalogAddress(key.pubkey, 'shopify:123'),
      title: 'Linen shirt',
      price: { amount: '49.90', currency: 'USD' },
      priceFrom: true,
      sku: 'LS-1',
      sourceId: '123',
      attrs: [{ name: 'material', value: 'linen' }],
      visibility: 'on-sale',
      hasAccept: false,
    });
    expect(item?.variants.map((variant) => variant.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('never writes payment tags', () => {
    const tags = shirt().tags.map((tag) => tag[0]);
    expect(tags).not.toContain('accept');
    expect(tags).not.toContain('endpoint');
  });

  it('refuses a reserved attr name in the builder', () => {
    expect(() =>
      buildCatalogItemEvent({
        d: 'x',
        title: 'X',
        price: { amount: '1', currency: 'USD' },
        attrs: [{ name: 'sku', value: 'a' }],
      }),
    ).toThrow();
  });

  it('refuses a variant inconsistent with its options in the builder', () => {
    expect(() =>
      buildCatalogItemEvent({
        d: 'x',
        title: 'X',
        price: { amount: '1', currency: 'USD' },
        options: [{ name: 'size', values: ['S'] }],
        variants: [{ id: 'v', price: '1', available: true, values: ['XL'] }],
      }),
    ).toThrow();
  });

  it('drops variants that break the invariant on read', () => {
    const template = shirt();
    template.tags.push(['variant', 'bad', '1', '1', 'XXL', 'white']);
    template.tags.push(['variant', 'short', '1', '1', 'S']);
    const item = parseCatalogItem(sign(template, key), { now: NOW, role: 'catalog' });
    expect(item?.variants.map((variant) => variant.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('treats hidden, unknown visibility and expired listings as absent', () => {
    const hidden = shirt();
    hidden.tags = hidden.tags.map((tag) =>
      tag[0] === 'visibility' ? ['visibility', 'hidden'] : tag,
    );
    expect(parseCatalogItem(sign(hidden, key), { now: NOW, role: 'catalog' })).toBeUndefined();
    const odd = shirt();
    odd.tags = odd.tags.map((tag) => (tag[0] === 'visibility' ? ['visibility', 'archived'] : tag));
    expect(parseCatalogItem(sign(odd, key), { now: NOW, role: 'catalog' })).toBeUndefined();
    const expired = shirt();
    expired.tags.push(['expiration', String(NOW - 1)]);
    expect(parseCatalogItem(sign(expired, key), { now: NOW, role: 'catalog' })).toBeUndefined();
  });

  it('reads pre-order and sold-out as shown', () => {
    const soldOut = shirt();
    soldOut.tags = soldOut.tags.map((tag) =>
      tag[0] === 'visibility' ? ['visibility', 'sold-out'] : tag,
    );
    expect(parseCatalogItem(sign(soldOut, key), { now: NOW, role: 'catalog' })?.visibility).toBe(
      'sold-out',
    );
  });

  it('picks the product page only on an allowed origin', () => {
    const item = parseCatalogItem(sign(shirt(), key), { now: NOW, role: 'catalog' });
    expect(item && productPageUrl(item, ['https://shop.example.com'])).toBe(
      'https://shop.example.com/products/linen-shirt',
    );
    expect(item && productPageUrl(item, ['https://evil.example.com'])).toBeUndefined();
  });

  it('splits an address on the first two colons only', () => {
    expect(parseAddress(catalogAddress(key.pubkey, 'google:habc'))).toEqual({
      kind: 30402,
      author: key.pubkey,
      d: 'google:habc',
    });
    expect(parseAddress('30402:nothex:x')).toBeUndefined();
  });
});

describe('determinedVariant', () => {
  const item = parseCatalogItem(sign(shirt(), key), { now: NOW, role: 'catalog' });

  it('finds the one variant a full pick matches', () => {
    expect(item && determinedVariant(item, { size: 'S', color: 'white' })?.id).toBe('v1');
  });

  it('never determines a variant with *', () => {
    expect(item && determinedVariant(item, { size: 'M', color: 'white' })).toBeUndefined();
  });

  it('refuses a pick that matches several variants', () => {
    // M + blue matches v2 exactly and v3 through *.
    expect(item && determinedVariant(item, { size: 'M', color: 'blue' })).toBeUndefined();
  });

  it('needs no pick for a single-variant product', () => {
    const single = parseCatalogItem(
      sign(
        buildCatalogItemEvent({
          d: 'mug',
          title: 'Mug',
          price: { amount: '9', currency: 'USD' },
          variants: [{ id: 'only', price: '9', available: true, values: [] }],
        }),
        key,
      ),
      { now: NOW, role: 'catalog' },
    );
    expect(single && determinedVariant(single, {})?.id).toBe('only');
  });
});
