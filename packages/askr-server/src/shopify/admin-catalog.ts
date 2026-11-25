import { LIMITS } from '@elisym/askr';
import * as z from 'zod';
import { SHOPIFY_POLICY_SLUGS } from '../connectors/constants';
import { htmlToText, inlineText } from '../connectors/html';
import { clip } from '../connectors/listing';
import type { ImportedPolicy, ShopifyProduct } from '../connectors/shopify';
import type { ShopifyClient } from './client';

/** A bulk result read at most (JSONL of every product, variant and image line). */
export const MAX_BULK_RESULT_BYTES = 256 * 1024 * 1024;
const BULK_POLL_MS = 2_000;
const MAX_IMAGES = 20;

/** The shop facts onboarding and `shop/update` read (plan 3.3, 3.5). */
export interface AdminShop {
  shopId: string;
  name: string;
  currency: string;
  myshopifyDomain: string;
  /** `https://<primary domain host>`. */
  primaryOrigin: string;
}

const ShopAnswerSchema = z.object({
  shop: z.object({
    id: z.string(),
    name: z.string(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/u),
    myshopifyDomain: z.string(),
    primaryDomain: z.object({ url: z.string() }),
  }),
});

const LocalesAnswerSchema = z.object({
  shopLocales: z.array(z.object({ locale: z.string(), primary: z.boolean() })),
});

const PoliciesAnswerSchema = z.object({
  shop: z.object({
    shopPolicies: z.array(z.object({ type: z.string(), title: z.string(), body: z.string() })),
  }),
});

const BulkStartSchema = z.object({
  bulkOperationRunQuery: z.object({
    bulkOperation: z.object({ id: z.string() }).nullable(),
    userErrors: z.array(z.object({ message: z.string() })),
  }),
});

const BulkStatusSchema = z.object({
  node: z
    .object({
      status: z.string(),
      errorCode: z.string().nullish(),
      url: z.string().nullish(),
    })
    .nullable(),
});

/** Shopify's `ShopPolicy.type` for each imported page handle. */
const POLICY_TYPES: Readonly<Record<string, string>> = {
  REFUND_POLICY: 'refund-policy',
  SHIPPING_POLICY: 'shipping-policy',
  PRIVACY_POLICY: 'privacy-policy',
  TERMS_OF_SERVICE: 'terms-of-service',
};

const SHOP_QUERY = `{ shop { id name currencyCode myshopifyDomain primaryDomain { url } } }`;
const LOCALES_QUERY = `{ shopLocales { locale primary } }`;
const POLICIES_QUERY = `{ shop { shopPolicies { type title body } } }`;

/**
 * Every active product with its variants and images (plan 3.5), as one bulk operation: no
 * query-cost limit and no paging. Only products published to the Online Store carry an
 * `onlineStoreUrl`; the rest are dropped after reading.
 */
const PRODUCTS_BULK_QUERY = `{
  products(query: "status:active") {
    edges { node {
      id legacyResourceId title handle descriptionHtml vendor productType tags onlineStoreUrl
      options { name optionValues { name } }
      media { edges { node { id ... on MediaImage { image { url } } } } }
      variants { edges { node {
        id legacyResourceId sku price availableForSale selectedOptions { name value }
      } } }
    } }
  }
}`;

const START_BULK = `mutation run($query: String!) {
  bulkOperationRunQuery(query: $query) { bulkOperation { id } userErrors { message } }
}`;

const BULK_STATUS = `query status($id: ID!) {
  node(id: $id) { ... on BulkOperation { status errorCode url } }
}`;

const BulkProductSchema = z.object({
  id: z.string().startsWith('gid://shopify/Product/'),
  legacyResourceId: z.string(),
  title: z.string(),
  handle: z.string(),
  descriptionHtml: z.string().nullish(),
  vendor: z.string().nullish(),
  productType: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  onlineStoreUrl: z.string().nullish(),
  options: z
    .array(z.object({ name: z.string(), optionValues: z.array(z.object({ name: z.string() })) }))
    .nullish(),
});

const BulkVariantSchema = z.object({
  id: z.string().startsWith('gid://shopify/ProductVariant/'),
  legacyResourceId: z.string(),
  sku: z.string().nullish(),
  price: z.string(),
  availableForSale: z.boolean(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  __parentId: z.string(),
});

const BulkImageSchema = z.object({
  image: z.object({ url: z.string() }).nullish(),
  __parentId: z.string(),
});

/** The shop facts, read with the shop's access token. */
export async function readShop(
  client: ShopifyClient,
  shop: string,
  token: string,
): Promise<AdminShop> {
  const answer = ShopAnswerSchema.parse(await client.graphql(shop, token, SHOP_QUERY));
  const primary = new URL(answer.shop.primaryDomain.url);
  return {
    shopId: answer.shop.id,
    name: answer.shop.name,
    currency: answer.shop.currencyCode,
    myshopifyDomain: answer.shop.myshopifyDomain,
    primaryOrigin: `https://${primary.host}`,
  };
}

/** The shop's primary locale, or undefined when it cannot be read (the config falls back). */
export async function readPrimaryLocale(
  client: ShopifyClient,
  shop: string,
  token: string,
): Promise<string | undefined> {
  try {
    const answer = LocalesAnswerSchema.parse(await client.graphql(shop, token, LOCALES_QUERY));
    return answer.shopLocales.find((locale) => locale.primary)?.locale;
  } catch {
    return undefined;
  }
}

/** The shop's refund, shipping, privacy and terms policies as 30495 inputs (plan 3.5). */
export async function readShopPolicies(
  client: ShopifyClient,
  shop: string,
  token: string,
): Promise<ImportedPolicy[]> {
  const answer = PoliciesAnswerSchema.parse(await client.graphql(shop, token, POLICIES_QUERY));
  const policies: ImportedPolicy[] = [];
  for (const { handle, slug } of SHOPIFY_POLICY_SLUGS) {
    const found = answer.shop.shopPolicies.find((policy) => POLICY_TYPES[policy.type] === handle);
    if (found === undefined) {
      continue;
    }
    const body = htmlToText(found.body);
    if (body === '') {
      continue;
    }
    const title = inlineText(found.title) || handle;
    const clippedBody = clip(body, LIMITS.POLICY_CONTENT_CHARS);
    const clippedTitle = clip(title, LIMITS.TITLE_CHARS);
    policies.push({
      input: { slug, title: clippedTitle, body: clippedBody },
      truncated: clippedBody !== body || clippedTitle !== title,
    });
  }
  return policies;
}

/**
 * Bulk result lines as products in the public `/products.json` shape, so the public reader's
 * mapping (`mapShopifyProduct`) turns them into the same listings: numeric variant ids, the same
 * option and availability rules. Products not on the Online Store are left out. Throws on a line
 * that is no JSON; lines of an unknown shape are counted as malformed.
 */
export function productsFromBulk(jsonl: string): { products: ShopifyProduct[]; malformed: number } {
  const products = new Map<string, ShopifyProduct>();
  const optionNames = new Map<string, string[]>();
  const online = new Set<string>();
  let malformed = 0;
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const value: unknown = JSON.parse(line);
    const product = BulkProductSchema.safeParse(value);
    if (product.success) {
      const node = product.data;
      const options = (node.options ?? []).slice(0, 3);
      optionNames.set(
        node.id,
        options.map((option) => option.name),
      );
      if (node.onlineStoreUrl !== null && node.onlineStoreUrl !== undefined) {
        online.add(node.id);
      }
      products.set(node.id, {
        id: node.legacyResourceId,
        title: node.title,
        handle: node.handle,
        body_html: node.descriptionHtml ?? null,
        vendor: node.vendor ?? null,
        product_type: node.productType ?? null,
        tags: node.tags ?? [],
        variants: [],
        images: [],
        options: options.map((option) => ({
          name: option.name,
          values: option.optionValues.map((optionValue) => optionValue.name),
        })),
      });
      continue;
    }
    const variant = BulkVariantSchema.safeParse(value);
    if (variant.success) {
      const parent = products.get(variant.data.__parentId);
      if (parent === undefined) {
        malformed += 1;
        continue;
      }
      const names = optionNames.get(variant.data.__parentId) ?? [];
      const valueOf = (index: number) =>
        variant.data.selectedOptions.find((option) => option.name === names[index])?.value ?? null;
      parent.variants.push({
        id: variant.data.legacyResourceId,
        option1: valueOf(0),
        option2: valueOf(1),
        option3: valueOf(2),
        sku: variant.data.sku ?? null,
        available: variant.data.availableForSale,
        price: variant.data.price,
      });
      continue;
    }
    const image = BulkImageSchema.safeParse(value);
    if (image.success) {
      const parent = products.get(image.data.__parentId);
      const url = image.data.image?.url;
      if (parent !== undefined && url !== undefined && (parent.images?.length ?? 0) < MAX_IMAGES) {
        parent.images?.push({ src: url });
      }
      continue;
    }
    malformed += 1;
  }
  return {
    products: [...products].filter(([id]) => online.has(id)).map(([, product]) => product),
    malformed,
  };
}

/**
 * Every product of the shop through one Admin API bulk operation (plan 3.5): started, polled
 * until done, its JSONL read. Throws on any failure, so a partial catalog never reaches a sync.
 */
export async function readShopProducts(
  client: ShopifyClient,
  shop: string,
  token: string,
  options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ products: ShopifyProduct[]; malformed: number }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = BulkStartSchema.parse(
    await client.graphql(shop, token, START_BULK, { query: PRODUCTS_BULK_QUERY }),
  );
  const operation = started.bulkOperationRunQuery.bulkOperation;
  if (operation === null) {
    const reason = started.bulkOperationRunQuery.userErrors[0]?.message ?? 'refused';
    throw new Error(`The shop's product export did not start: ${reason.slice(0, 200)}`);
  }
  for (;;) {
    if (options.signal?.aborted === true) {
      throw new Error("The shop's product export took too long");
    }
    const status = BulkStatusSchema.parse(
      await client.graphql(shop, token, BULK_STATUS, { id: operation.id }),
    ).node;
    if (status === null) {
      throw new Error("The shop's product export is gone");
    }
    if (status.status === 'COMPLETED') {
      if (status.url === null || status.url === undefined) {
        return { products: [], malformed: 0 };
      }
      return productsFromBulk(await client.bulkResult(status.url, MAX_BULK_RESULT_BYTES));
    }
    if (status.status !== 'CREATED' && status.status !== 'RUNNING') {
      throw new Error(
        `The shop's product export ended ${status.status}${status.errorCode ? ` (${status.errorCode})` : ''}`,
      );
    }
    await sleep(BULK_POLL_MS);
  }
}
