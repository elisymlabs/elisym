import { type CatalogAttr, LIMITS, type PolicyInput } from '@elisym/askr';
import { z } from 'zod';
import {
  FETCH_TIMEOUT_MS,
  MAX_PAGE_BYTES,
  SHOPIFY_MAX_PAGES,
  SHOPIFY_PAGE_SIZE,
  SHOPIFY_POLICY_SLUGS,
} from './constants';
import { htmlToText, inlineText } from './html';
import { type ShopHttp, SourceClosedError, getJson } from './http';
import { type DraftOption, type DraftVariant, type ProductDraft, clip } from './listing';

const idSchema = z.union([z.number().int().nonnegative(), z.string().min(1)]).transform(String);
const optionalText = z.string().nullish();

const shopifyVariantSchema = z.object({
  id: idSchema,
  option1: optionalText,
  option2: optionalText,
  option3: optionalText,
  sku: optionalText,
  available: z.boolean().nullish(),
  price: z.union([z.string(), z.number()]).transform(String),
});

const shopifyProductSchema = z.object({
  id: idSchema,
  title: z.string(),
  handle: z.string(),
  body_html: optionalText,
  vendor: optionalText,
  product_type: optionalText,
  tags: z.union([z.array(z.string()), z.string()]).nullish(),
  variants: z.array(shopifyVariantSchema),
  images: z.array(z.object({ src: z.string() }).passthrough()).nullish(),
  options: z
    .array(z.object({ name: z.string(), values: z.array(z.string()).nullish() }).passthrough())
    .nullish(),
});

export type ShopifyProduct = z.infer<typeof shopifyProductSchema>;

const productsPageSchema = z.object({ products: z.array(z.unknown()) });

/** Products a page holds, and the raw entries that were not Shopify products. */
export interface ShopifyPage {
  products: ShopifyProduct[];
  malformed: number;
  rawCount: number;
}

/** A `/products.json` page, or undefined when the body is not one. */
export function parseShopifyPage(json: unknown): ShopifyPage | undefined {
  const page = productsPageSchema.safeParse(json);
  if (!page.success) {
    return undefined;
  }
  const products: ShopifyProduct[] = [];
  let malformed = 0;
  for (const raw of page.data.products) {
    const product = shopifyProductSchema.safeParse(raw);
    if (product.success) {
      products.push(product.data);
    } else {
      malformed += 1;
    }
  }
  return { products, malformed, rawCount: page.data.products.length };
}

function isDefaultTitleOnly(product: ShopifyProduct): boolean {
  const options = product.options ?? [];
  const [only] = options;
  return (
    options.length === 1 &&
    only !== undefined &&
    only.name === 'Title' &&
    product.variants.every((variant) => variant.option1 === 'Default Title')
  );
}

/**
 * A Shopify product (`/products.json`) as a draft listing (7.4): every
 * variant (the "Default Title" option of a single-variant product is not an
 * option), `r` = `/products/{handle}`, vendor and type as attrs, tags as topics.
 */
export function mapShopifyProduct(
  product: ShopifyProduct,
  shop: { origin: string; currency: string },
): ProductDraft {
  const options: DraftOption[] = isDefaultTitleOnly(product)
    ? []
    : (product.options ?? []).slice(0, 3).map((option) => ({
        name: option.name,
        values: option.values ?? [],
      }));
  const variants: DraftVariant[] = product.variants.map((variant) => {
    const draft: DraftVariant = {
      id: variant.id,
      price: variant.price,
      available: variant.available === true,
      values: [variant.option1, variant.option2, variant.option3]
        .slice(0, options.length)
        .map((value) => value ?? ''),
    };
    if (variant.sku) {
      draft.sku = variant.sku;
    }
    return draft;
  });
  const attrs: CatalogAttr[] = [];
  if (product.vendor) {
    attrs.push({ name: 'brand', value: product.vendor });
  }
  if (product.product_type) {
    attrs.push({ name: 'type', value: product.product_type });
  }
  let tags: string[] = [];
  if (typeof product.tags === 'string') {
    tags = product.tags.split(',');
  } else if (Array.isArray(product.tags)) {
    tags = product.tags;
  }
  return {
    platform: 'shopify',
    sourceId: product.id,
    title: inlineText(product.title),
    description: htmlToText(product.body_html ?? ''),
    currency: shop.currency,
    images: (product.images ?? []).map((image) => image.src),
    topics: tags.map((tag) => tag.trim()).filter((tag) => tag !== ''),
    url: `${shop.origin}/products/${encodeURIComponent(product.handle)}`,
    attrs,
    options,
    variants,
  };
}

const metaSchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/u) });

/** The shop's currency from `/meta.json` (`/products.json` carries none). */
export async function fetchShopifyCurrency(
  http: ShopHttp,
  origin: string,
): Promise<string | undefined> {
  const json = await getJson(
    http,
    `${origin}/meta.json`,
    { maxBytes: MAX_PAGE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
    false,
  );
  const meta = metaSchema.safeParse(json);
  return meta.success ? meta.data.currency : undefined;
}

/**
 * Every product of the shop, page by page until a short page. Throws on any
 * failure: a partial list must never reach `syncCatalog`, which would hide the
 * rest. More pages than `SHOPIFY_MAX_PAGES` is an error for the same reason.
 */
export async function fetchShopifyProducts(
  http: ShopHttp,
  origin: string,
): Promise<{ products: ShopifyProduct[]; malformed: number }> {
  const products: ShopifyProduct[] = [];
  let malformed = 0;
  for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
    const url = `${origin}/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${page}`;
    const json = await getJson(
      http,
      url,
      { maxBytes: MAX_PAGE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
      page === 1,
    );
    const parsed = parseShopifyPage(json);
    if (!parsed) {
      if (page === 1) {
        throw new SourceClosedError(url, 'not a products.json answer', 200);
      }
      throw new Error(`Unexpected answer from ${url}`);
    }
    products.push(...parsed.products);
    malformed += parsed.malformed;
    if (parsed.rawCount < SHOPIFY_PAGE_SIZE) {
      return { products, malformed };
    }
  }
  throw new Error(`More than ${SHOPIFY_MAX_PAGES * SHOPIFY_PAGE_SIZE} products`);
}

const policySchema = z.object({
  policy: z.object({ title: z.string(), body: z.string() }),
});

export interface ImportedPolicy {
  input: PolicyInput;
  truncated: boolean;
}

/**
 * The shop's refund, shipping, privacy and terms pages as 30495 inputs (7.4),
 * read from `/policies/{handle}.json`: the same public page as
 * `/policies/{handle}`, without the theme around it. A missing (404) or empty
 * page is absent; any other failure throws, so a hiccup never removes a policy.
 */
export async function fetchShopifyPolicies(
  http: ShopHttp,
  origin: string,
): Promise<ImportedPolicy[]> {
  const policies: ImportedPolicy[] = [];
  for (const { handle, slug } of SHOPIFY_POLICY_SLUGS) {
    let json: unknown;
    try {
      json = await getJson(
        http,
        `${origin}/policies/${handle}.json`,
        { maxBytes: MAX_PAGE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
        true,
      );
    } catch (error) {
      if (error instanceof SourceClosedError && error.httpStatus === 404) {
        continue;
      }
      throw error;
    }
    const parsed = policySchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Unexpected policy answer for ${handle}`);
    }
    const body = htmlToText(parsed.data.policy.body);
    if (body === '') {
      continue;
    }
    const title = inlineText(parsed.data.policy.title) || handle;
    const clippedBody = clip(body, LIMITS.POLICY_CONTENT_CHARS);
    const clippedTitle = clip(title, LIMITS.TITLE_CHARS);
    policies.push({
      input: { slug, title: clippedTitle, body: clippedBody },
      truncated: clippedBody !== body || clippedTitle !== title,
    });
  }
  return policies;
}
