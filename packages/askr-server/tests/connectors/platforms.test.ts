// cspell:ignore LFVJBK allbirds
import { buildCatalogItemEvent, determinedVariant, parseCatalogItem } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { type FitResult, fitDraft } from '../../src/connectors/listing';
import {
  type ShopifyProduct,
  mapShopifyProduct,
  parseShopifyPage,
} from '../../src/connectors/shopify';
import {
  type WooProduct,
  type WooVariation,
  mapWooProduct,
  parseWooProduct,
  parseWooVariation,
  wooAmount,
} from '../../src/connectors/woocommerce';
import { fixtureJson } from './helpers';

const SHOP = { origin: 'https://www.deathwishcoffee.com', currency: 'USD' };

function shopifyProducts(): ShopifyProduct[] {
  const page = parseShopifyPage(fixtureJson('shopify-products.json'));
  if (!page) {
    throw new Error('fixture is not a products page');
  }
  return page.products;
}

function shopifyProduct(id: string): ShopifyProduct {
  const product = shopifyProducts().find((candidate) => candidate.id === id);
  if (!product) {
    throw new Error(`no product ${id}`);
  }
  return product;
}

function listing(result: FitResult) {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result;
}

function wooFixtures(): { products: WooProduct[]; variations: Map<number, WooVariation> } {
  const raw = fixtureJson('woo-products.json');
  const rawVariations = fixtureJson('woo-variations.json');
  if (!Array.isArray(raw) || typeof rawVariations !== 'object' || rawVariations === null) {
    throw new Error('bad fixtures');
  }
  const products = raw
    .map((entry: unknown) => parseWooProduct(entry))
    .filter((product) => product !== undefined);
  const variations = new Map<number, WooVariation>();
  for (const value of Object.values(rawVariations)) {
    const variation = parseWooVariation(value);
    if (variation) {
      variations.set(variation.id, variation);
    }
  }
  expect(products).toHaveLength(3);
  expect(variations.size).toBe(8);
  return { products, variations };
}

describe('Shopify /products.json (real, trimmed responses)', () => {
  it('parses every fixture product', () => {
    expect(shopifyProducts()).toHaveLength(3);
    expect(parseShopifyPage({ nope: [] })).toBeUndefined();
    expect(parseShopifyPage({ products: [{ id: 1 }] })).toEqual({
      products: [],
      malformed: 1,
      rawCount: 1,
    });
  });

  it('single-variant product: one variant, its SKU, the product page, attrs and topics', () => {
    const fitted = listing(fitDraft(mapShopifyProduct(shopifyProduct('6635123015735'), SHOP)));
    expect(fitted.listing).toMatchObject({
      d: 'shopify:6635123015735',
      sourceId: '6635123015735',
      sku: 'LFVJBK04',
      title: 'Valhalla Java Dark Chocolate Bark',
      price: { amount: '15.00', currency: 'USD' },
      url: 'https://www.deathwishcoffee.com/products/valhalla-java-dark-chocolate-bark',
      options: [{ name: 'Size', values: ['1 Pack'] }],
      variants: [{ id: '39660132106295', price: '15.00', available: true, values: ['1 Pack'] }],
      visibility: 'on-sale',
      attrs: [
        { name: 'brand', value: 'Ethereal Confections' },
        { name: 'type', value: 'Chocolate' },
      ],
    });
    expect(fitted.listing.topics).toContain('Gifting');
    expect(fitted.listing.description).toContain('Heavenly Flavor, Hellish Strength.');
    expect(fitted.listing.description).not.toContain('<');
    expect(fitted.truncated).toBe(false);
  });

  it('two options, eight variants with differing SKUs and prices', () => {
    const fitted = listing(fitDraft(mapShopifyProduct(shopifyProduct('7420854370359'), SHOP)));
    expect(fitted.listing.options).toEqual([
      { name: 'Type', values: ['Ground', 'Whole Bean'] },
      { name: 'Size', values: ['1 lb', '2 lbs', '3 lbs', '5 lbs'] },
    ]);
    expect(fitted.listing.variants).toHaveLength(8);
    expect(fitted.listing.sku).toBeUndefined();
    expect(fitted.listing.price.amount).toBe('19.99');
    const event = { ...buildCatalogItemEvent(fitted.listing), pubkey: 'b'.repeat(64) };
    expect(event.tags).toContainEqual(['price-from', '1']);
    const item = parseCatalogItem(event, { role: 'catalog', now: 1 });
    expect(item && determinedVariant(item, { Type: 'Whole Bean', Size: '2 lbs' })?.id).toBe(
      '42123932500023',
    );
  });

  it('13 sizes: cut to 10 values, available sizes kept', () => {
    const fitted = listing(fitDraft(mapShopifyProduct(shopifyProduct('7292464824400'), SHOP)));
    const kept = fitted.listing.variants ?? [];
    expect(fitted.truncated).toBe(true);
    expect(fitted.listing.options?.[0]?.values).toHaveLength(10);
    expect(kept.filter((variant) => variant.available).map((variant) => variant.values[0])).toEqual(
      ['8', '8.5', '9'],
    );
    expect(fitted.listing.visibility).toBe('on-sale');
    expect(fitted.listing.price.amount).toBe('120.00');
    // The tag `allbirds::cfId => color-...` is longer than 64 characters and is clipped.
    expect(fitted.listing.topics?.every((topic) => topic.length <= 64)).toBe(true);
  });

  it('a "Default Title" product has no option; all sold out gives sold-out', () => {
    const product: ShopifyProduct = {
      ...shopifyProduct('6635123015735'),
      options: [{ name: 'Title', values: ['Default Title'] }],
      variants: [
        {
          id: '1',
          option1: 'Default Title',
          option2: null,
          option3: null,
          sku: 'X',
          available: false,
          price: '9.00',
        },
      ],
    };
    const fitted = listing(fitDraft(mapShopifyProduct(product, SHOP)));
    expect(fitted.listing.options).toEqual([]);
    expect(fitted.listing.variants).toEqual([
      { id: '1', price: '9.00', available: false, values: [] },
    ]);
    expect(fitted.listing.visibility).toBe('sold-out');
  });

  it('an option genuinely named "Title" with other values stays an option', () => {
    const base = {
      option2: null,
      option3: null,
      sku: null,
      available: true,
      price: '9.00',
    };
    const product: ShopifyProduct = {
      ...shopifyProduct('6635123015735'),
      options: [{ name: 'Title', values: ['Default Title', 'Signed'] }],
      variants: [
        { ...base, id: '1', option1: 'Default Title' },
        { ...base, id: '2', option1: 'Signed' },
      ],
    };
    const fitted = listing(fitDraft(mapShopifyProduct(product, SHOP)));
    expect(fitted.listing.options).toEqual([
      { name: 'Title', values: ['Default Title', 'Signed'] },
    ]);
    expect(fitted.listing.variants?.map((variant) => variant.values)).toEqual([
      ['Default Title'],
      ['Signed'],
    ]);
  });
});

describe('WooCommerce Store API (real, trimmed responses)', () => {
  it('converts minor units through decimals', () => {
    expect(wooAmount({ price: '17500', currency_code: 'USD', currency_minor_unit: 2 })).toBe('175');
    expect(wooAmount({ price: '1999', currency_code: 'JPY', currency_minor_unit: 0 })).toBe('1999');
    expect(wooAmount({ price: '5', currency_code: 'BHD', currency_minor_unit: 3 })).toBe('0.005');
    expect(wooAmount({ price: '', currency_code: 'USD', currency_minor_unit: 2 })).toBeUndefined();
    expect(
      wooAmount({ price: '-1', currency_code: 'USD', currency_minor_unit: 2 }),
    ).toBeUndefined();
  });

  it('never rounds a price with more than 20 significant digits', () => {
    expect(
      wooAmount({
        price: '123456789012345678901234567890',
        currency_code: 'USD',
        currency_minor_unit: 18,
      }),
    ).toBe('123456789012.34567890123456789');
    expect(wooAmount({ price: '1'.repeat(30), currency_code: 'USD', currency_minor_unit: 2 })).toBe(
      `${'1'.repeat(28)}.11`,
    );
    expect(
      wooAmount({ price: '1'.repeat(31), currency_code: 'USD', currency_minor_unit: 2 }),
    ).toBeUndefined();
  });

  it('a price too large for a listing skips the product instead of rounding it', () => {
    const { products, variations } = wooFixtures();
    const simple = products.find((candidate) => candidate.type === 'simple');
    if (!simple) {
      throw new Error('fixture');
    }
    const mapped = mapWooProduct(
      { ...simple, prices: { ...simple.prices, price: '1'.repeat(25) } },
      variations,
      'https://woocommerce.com',
    );
    if (!mapped.ok) {
      throw new Error(mapped.reason);
    }
    expect(fitDraft(mapped.draft).ok).toBe(false);
  });

  it('an external (affiliate) product is listed with its stock, with no variant', () => {
    const { products, variations } = wooFixtures();
    const simple = products.find((candidate) => candidate.type === 'simple');
    if (!simple) {
      throw new Error('fixture');
    }
    const affiliate: WooProduct = {
      ...simple,
      type: 'external',
      sku: 'AFF-1',
      is_purchasable: false,
      is_in_stock: true,
    };
    const mapped = mapWooProduct(affiliate, variations, 'https://woocommerce.com');
    if (!mapped.ok) {
      throw new Error(mapped.reason);
    }
    const fitted = listing(fitDraft(mapped.draft));
    expect(fitted.listing).toMatchObject({
      price: { amount: '59' },
      visibility: 'on-sale',
      variants: [],
      sku: 'AFF-1',
    });
    const event = buildCatalogItemEvent(fitted.listing);
    expect(event.tags.filter((tag) => tag[0] === 'variant')).toEqual([]);
    const outOfStock = mapWooProduct(
      { ...affiliate, is_in_stock: false },
      variations,
      'https://woocommerce.com',
    );
    expect(outOfStock.ok && listing(fitDraft(outOfStock.draft)).listing.visibility).toBe(
      'sold-out',
    );
    const unpriced = mapWooProduct(
      { ...affiliate, prices: { ...affiliate.prices, price: '' } },
      variations,
      'https://woocommerce.com',
    );
    expect(unpriced.ok).toBe(false);
  });

  it('"Any" variations: * values, the option offers the attribute terms', () => {
    const { products, variations } = wooFixtures();
    const product = products.find((candidate) => candidate.id === 191);
    if (!product) {
      throw new Error('fixture');
    }
    const mapped = mapWooProduct(product, variations, 'https://websitedemos.net');
    if (!mapped.ok) {
      throw new Error(mapped.reason);
    }
    const fitted = listing(fitDraft(mapped.draft));
    expect(fitted.listing.options).toEqual([
      { name: 'Size', values: ['L', 'M', 'S', 'XL', 'XS'] },
      { name: 'Color', values: ['Black', 'Green', 'Red', 'White'] },
    ]);
    expect(fitted.listing.variants?.find((variant) => variant.id === '502')).toEqual({
      id: '502',
      price: '134.9',
      available: true,
      values: ['*', 'Black'],
    });
    expect(fitted.listing.price.amount).toBe('124.9');
    expect(fitted.listing.topics).toEqual(['Work & Office']);
    expect(fitted.listing.url).toBe(
      'https://websitedemos.net/clothing-store-02/product/timeless-classic-collection/',
    );
    const event = { ...buildCatalogItemEvent(fitted.listing), pubkey: 'c'.repeat(64) };
    const item = parseCatalogItem(event, { role: 'catalog', now: 1 });
    // A variant holding `*` is never a determined variant.
    expect(item && determinedVariant(item, { Size: 'M', Color: 'Black' })).toBeUndefined();
  });

  it('variable product: per-variation price and stock, price-from, variant ids', () => {
    const { products, variations } = wooFixtures();
    const product = products.find((candidate) => candidate.id === 375);
    if (!product) {
      throw new Error('fixture');
    }
    const outOfStock = new Map(variations);
    const blue = variations.get(4120);
    if (blue) {
      outOfStock.set(4120, { ...blue, is_in_stock: false });
    }
    const mapped = mapWooProduct(product, outOfStock, 'https://websitedemos.net');
    if (!mapped.ok) {
      throw new Error(mapped.reason);
    }
    const fitted = listing(fitDraft(mapped.draft));
    // Blue (175) is out of stock: the price is the lowest available, Aqua at 185.
    expect(fitted.listing.price.amount).toBe('185');
    expect(fitted.listing.variants?.[0]).toMatchObject({ id: '4119', values: ['Aqua'] });
    expect(fitted.listing.variants?.find((variant) => variant.id === '4120')?.available).toBe(
      false,
    );
    expect(fitted.listing.options).toEqual([
      { name: 'Color', values: ['Aqua', 'Blue', 'Green', 'Red'] },
    ]);
  });

  it('a variation that could not be read is left out and reported', () => {
    const { products, variations } = wooFixtures();
    const product = products.find((candidate) => candidate.id === 375);
    if (!product) {
      throw new Error('fixture');
    }
    const partial = new Map(variations);
    partial.delete(4122);
    const mapped = mapWooProduct(product, partial, 'https://websitedemos.net');
    expect(mapped.ok && mapped.missingVariations).toBe(1);
    const none = mapWooProduct(product, new Map(), 'https://websitedemos.net');
    expect(none.ok).toBe(false);
  });

  it('simple product: the product id is the single variant', () => {
    const { products, variations } = wooFixtures();
    const product = products.find((candidate) => candidate.type === 'simple');
    if (!product) {
      throw new Error('fixture');
    }
    const mapped = mapWooProduct(product, variations, 'https://woocommerce.com');
    if (!mapped.ok) {
      throw new Error(mapped.reason);
    }
    const fitted = listing(fitDraft(mapped.draft));
    expect(fitted.listing.variants).toEqual([
      { id: String(product.id), price: '59', available: true, values: [] },
    ]);
    expect(fitted.listing.url).toBe('https://woocommerce.com/products/quote-request/');
  });

  it('drops a permalink on another origin and refuses grouped products', () => {
    const { products, variations } = wooFixtures();
    const simple = products.find((candidate) => candidate.type === 'simple');
    if (!simple) {
      throw new Error('fixture');
    }
    const foreign = mapWooProduct(simple, variations, 'https://other-shop.example');
    expect(foreign.ok && foreign.draft.url).toBeUndefined();
    expect(
      mapWooProduct({ ...simple, type: 'grouped' }, variations, 'https://woocommerce.com').ok,
    ).toBe(false);
  });

  it('maps a simple product SKU, brands and non-variation attributes', () => {
    const { products, variations } = wooFixtures();
    const simple = products.find((candidate) => candidate.type === 'simple');
    if (!simple) {
      throw new Error('fixture');
    }
    const mapped = mapWooProduct(
      {
        ...simple,
        sku: 'Q-1',
        brands: [{ name: 'Woo &amp; Co' }],
        attributes: [
          { name: 'Material', has_variations: false, terms: [{ name: 'Steel', slug: 'steel' }] },
        ],
      },
      variations,
      'https://woocommerce.com',
    );
    const fitted = mapped.ok ? listing(fitDraft(mapped.draft)) : undefined;
    expect(fitted?.listing.sku).toBe('Q-1');
    expect(fitted?.listing.attrs).toEqual([
      { name: 'brand', value: 'Woo & Co' },
      { name: 'Material', value: 'Steel' },
    ]);
  });
});
