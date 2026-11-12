import type { CatalogAttr } from '@elisym/askr';
import Decimal from 'decimal.js-light';
import { z } from 'zod';
import {
  FETCH_TIMEOUT_MS,
  MAX_PAGE_BYTES,
  WOO_MAX_PAGES,
  WOO_PAGE_SIZE,
  WOO_VARIATION_BATCH,
} from './constants';
import { decodeHtmlEntities, htmlToText, inlineText } from './html';
import { type ShopHttp, SourceClosedError, getJson } from './http';
import type { DraftOption, DraftVariant, ProductDraft } from './listing';

const named = z.object({ name: z.string() }).passthrough();

const wooPricesSchema = z.object({
  price: z.string(),
  currency_code: z.string(),
  currency_minor_unit: z.number().int().min(0).max(18),
});

const wooAttributeSchema = z.object({
  name: z.string(),
  taxonomy: z.string().nullish(),
  has_variations: z.boolean().nullish(),
  terms: z.array(z.object({ name: z.string(), slug: z.string().nullish() })).nullish(),
});

const wooVariationRefSchema = z.object({
  id: z.number().int().nonnegative(),
  attributes: z.array(z.object({ name: z.string(), value: z.string().nullish() })),
});

const wooProductSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  type: z.string(),
  permalink: z.string().nullish(),
  sku: z.string().nullish(),
  short_description: z.string().nullish(),
  description: z.string().nullish(),
  prices: wooPricesSchema,
  images: z.array(z.object({ src: z.string() }).passthrough()).nullish(),
  categories: z.array(named).nullish(),
  tags: z.array(named).nullish(),
  brands: z.array(named).nullish(),
  attributes: z.array(wooAttributeSchema).nullish(),
  variations: z.array(wooVariationRefSchema).nullish(),
  is_in_stock: z.boolean().nullish(),
  is_purchasable: z.boolean().nullish(),
});

export type WooProduct = z.infer<typeof wooProductSchema>;

const wooVariationSchema = z.object({
  id: z.number().int().nonnegative(),
  sku: z.string().nullish(),
  prices: wooPricesSchema,
  is_in_stock: z.boolean().nullish(),
  is_purchasable: z.boolean().nullish(),
});

export type WooVariation = z.infer<typeof wooVariationSchema>;

/** A Store API product, or undefined when the entry is not one. */
export function parseWooProduct(raw: unknown): WooProduct | undefined {
  const product = wooProductSchema.safeParse(raw);
  return product.success ? product.data : undefined;
}

/** A Store API variation read, or undefined when the entry is not one. */
export function parseWooVariation(raw: unknown): WooVariation | undefined {
  const variation = wooVariationSchema.safeParse(raw);
  return variation.success ? variation.data : undefined;
}

/** Store API minor units to a decimal string: `17500` with unit 2 is `175`. */
export function wooAmount(prices: z.infer<typeof wooPricesSchema>): string | undefined {
  if (!/^\d{1,30}$/u.test(prices.price)) {
    return undefined;
  }
  return new Decimal(prices.price).div(new Decimal(10).pow(prices.currency_minor_unit)).toFixed();
}

function isAvailable(entry: { is_in_stock?: boolean | null; is_purchasable?: boolean | null }) {
  return entry.is_in_stock === true && entry.is_purchasable !== false;
}

/** The term name a variation value (a term slug, or the name for local attributes) stands for. */
function termName(attribute: z.infer<typeof wooAttributeSchema>, value: string): string {
  const lower = value.toLowerCase();
  const term = (attribute.terms ?? []).find(
    (candidate) => candidate.slug === value || candidate.name.toLowerCase() === lower,
  );
  return decodeHtmlEntities(term?.name ?? value);
}

function sameAttribute(attribute: z.infer<typeof wooAttributeSchema>, name: string): boolean {
  return attribute.name === name || (attribute.taxonomy ?? undefined) === name;
}

export type WooMapResult =
  | { ok: true; draft: ProductDraft; missingVariations: number }
  | { ok: false; sourceId: string; reason: string };

/**
 * A Store API product as a draft listing (7.4). A simple product is its own
 * single variant (its id is what `?add-to-cart=` takes); a variable product
 * has one variant per variation, priced and stocked from the variation reads,
 * with an "Any" attribute written as `*` and the attribute's terms kept for it.
 */
export function mapWooProduct(
  product: WooProduct,
  variations: ReadonlyMap<number, WooVariation>,
  shopOrigin: string,
): WooMapResult {
  const sourceId = String(product.id);
  if (product.type === 'grouped') {
    return { ok: false, sourceId, reason: 'grouped products are not listed' };
  }
  const attributes = product.attributes ?? [];
  const variationAttributes = attributes.filter((attribute) => attribute.has_variations === true);
  let options: DraftOption[] = [];
  const variants: DraftVariant[] = [];
  let missingVariations = 0;
  if (product.type === 'variable') {
    options = variationAttributes.map((attribute) => {
      const terms = (attribute.terms ?? []).map((term) => decodeHtmlEntities(term.name));
      return { name: decodeHtmlEntities(attribute.name), values: terms, terms };
    });
    for (const reference of product.variations ?? []) {
      const variation = variations.get(reference.id);
      const price = variation ? wooAmount(variation.prices) : undefined;
      if (!variation || price === undefined) {
        missingVariations += 1;
        continue;
      }
      const values = variationAttributes.map((attribute) => {
        const value = reference.attributes.find((entry) =>
          sameAttribute(attribute, entry.name),
        )?.value;
        return value ? termName(attribute, value) : '';
      });
      const draft: DraftVariant = {
        id: String(variation.id),
        price,
        available: isAvailable(variation),
        values,
      };
      if (variation.sku) {
        draft.sku = variation.sku;
      }
      variants.push(draft);
    }
    if (variants.length === 0) {
      return { ok: false, sourceId, reason: 'no readable variation' };
    }
  } else {
    const price = wooAmount(product.prices);
    if (price === undefined) {
      return { ok: false, sourceId, reason: 'no valid price' };
    }
    const draft: DraftVariant = {
      id: sourceId,
      price,
      available: isAvailable(product),
      values: [],
    };
    if (product.sku) {
      draft.sku = product.sku;
    }
    variants.push(draft);
  }
  const attrs: CatalogAttr[] = (product.brands ?? []).map((brand) => ({
    name: 'brand',
    value: decodeHtmlEntities(brand.name),
  }));
  for (const attribute of attributes) {
    if (attribute.has_variations === true && product.type === 'variable') {
      continue;
    }
    for (const term of attribute.terms ?? []) {
      attrs.push({
        name: decodeHtmlEntities(attribute.name),
        value: decodeHtmlEntities(term.name),
      });
    }
  }
  const draft: ProductDraft = {
    platform: 'woocommerce',
    sourceId,
    title: inlineText(product.name),
    description: htmlToText(product.description ?? ''),
    currency: product.prices.currency_code,
    images: (product.images ?? []).map((image) => image.src),
    topics: [...(product.categories ?? []), ...(product.tags ?? [])].map((entry) =>
      decodeHtmlEntities(entry.name),
    ),
    attrs,
    options,
    variants,
  };
  const summary = htmlToText(product.short_description ?? '');
  if (summary !== '') {
    draft.summary = summary;
  }
  // The product page only on the shop's own (verified) origin.
  if (product.permalink) {
    try {
      const permalink = new URL(product.permalink);
      if (permalink.origin === shopOrigin && permalink.protocol === 'https:') {
        draft.url = permalink.toString();
      }
    } catch {
      // A malformed permalink is left out.
    }
  }
  return { ok: true, draft, missingVariations };
}

function productsUrl(base: string, query: string): string {
  return `${base}/wp-json/wc/store/v1/products?${query}`;
}

/** Every product of the shop, page by page; throws on any failure (no partial catalog). */
export async function fetchWooProducts(
  http: ShopHttp,
  base: string,
): Promise<{ products: WooProduct[]; malformed: number }> {
  const products: WooProduct[] = [];
  let malformed = 0;
  for (let page = 1; page <= WOO_MAX_PAGES; page++) {
    const url = productsUrl(base, `per_page=${WOO_PAGE_SIZE}&page=${page}`);
    const json = await getJson(
      http,
      url,
      { maxBytes: MAX_PAGE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
      page === 1,
    );
    if (!Array.isArray(json)) {
      if (page === 1) {
        throw new SourceClosedError(url, 'not a Store API answer', 200);
      }
      throw new Error(`Unexpected answer from ${url}`);
    }
    for (const raw of json) {
      const product = parseWooProduct(raw);
      if (!product) {
        malformed += 1;
      } else if (product.type !== 'variation') {
        products.push(product);
      }
    }
    if (json.length < WOO_PAGE_SIZE) {
      return { products, malformed };
    }
  }
  throw new Error(`More than ${WOO_MAX_PAGES * WOO_PAGE_SIZE} products`);
}

/**
 * Price and stock of every variation (the product list carries neither):
 * batched through `type=variation&include=...`, then one read per variation
 * the batch did not return. A variation that is gone (404) is left out; any
 * other failure throws. Every request counts in the per-shop limits.
 */
export async function fetchWooVariations(
  http: ShopHttp,
  base: string,
  ids: readonly number[],
): Promise<Map<number, WooVariation>> {
  const found = new Map<number, WooVariation>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += WOO_VARIATION_BATCH) {
    const batch = unique.slice(start, start + WOO_VARIATION_BATCH);
    const json = await getJson(
      http,
      productsUrl(
        base,
        `type=variation&include=${batch.join(',')}&per_page=${WOO_VARIATION_BATCH}`,
      ),
      { maxBytes: MAX_PAGE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
      false,
    );
    for (const raw of Array.isArray(json) ? json : []) {
      const variation = parseWooVariation(raw);
      if (variation && batch.includes(variation.id)) {
        found.set(variation.id, variation);
      }
    }
  }
  for (const id of unique) {
    if (found.has(id)) {
      continue;
    }
    let json: unknown;
    try {
      json = await getJson(
        http,
        `${base}/wp-json/wc/store/v1/products/${id}`,
        { maxBytes: MAX_PAGE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
        true,
      );
    } catch (error) {
      if (error instanceof SourceClosedError) {
        if (error.httpStatus === 404) {
          continue;
        }
        // The list was open: a refused variation read is a failed sync, not a closed source.
        throw new Error(`Variation ${id}: ${error.reason}`);
      }
      throw error;
    }
    const variation = parseWooVariation(json);
    if (variation) {
      found.set(id, variation);
    }
  }
  return found;
}
