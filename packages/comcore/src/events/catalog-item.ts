import { type ProductPrice, nowSecs, parseProduct, tagsNamed, tagValues } from '@elisym/commerce';
import Decimal from 'decimal.js-light';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { z } from 'zod';
import {
  ANY_OPTION_VALUE,
  LIMITS,
  RESERVED_ATTRS,
  VISIBILITIES,
  type Visibility,
} from '../constants';
import type { CatalogKeyRole } from './catalog-auth';

const KIND_PRODUCT = 30402;
/** The `d` pattern `parseProduct` accepts; anything else is dropped by every reader. */
export const D_TAG_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PRICE_AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const FREQUENCIES = ['hour', 'day', 'week', 'month', 'year'] as const;

export interface CatalogAttr {
  name: string;
  value: string;
}

export interface CatalogOption {
  name: string;
  values: string[];
}

export interface CatalogVariant {
  id: string;
  /** Decimal string in the listing's currency, never a float. */
  price: string;
  available: boolean;
  /** One value per option, in option order; `*` = any value of that option. */
  values: string[];
}

export interface CatalogItem {
  author: string;
  d: string;
  /** `30402:<author>:<d>`. */
  address: string;
  title: string;
  summary?: string;
  description: string;
  price: ProductPrice;
  priceFrom: boolean;
  images: string[];
  topics: string[];
  /** Every https `r` tag in order; the product page is the first on an allowed origin (K12). */
  links: string[];
  /** Non-reserved attributes, filterable. */
  attrs: CatalogAttr[];
  sku?: string;
  sourceId?: string;
  options: CatalogOption[];
  variants: CatalogVariant[];
  visibility: Exclude<Visibility, 'hidden'>;
  /** Whether the listing carries Pay Core payment tags. */
  hasAccept: boolean;
  createdAt: number;
}

/** `30402:<author>:<d>`. */
export function catalogAddress(author: string, d: string): string {
  return `${KIND_PRODUCT}:${author}:${d}`;
}

/** Split `kind:pubkey:d` on the first two colons only: `d` may contain `:`. */
export function parseAddress(
  address: string,
): { kind: number; author: string; d: string } | undefined {
  const firstColon = address.indexOf(':');
  const secondColon = address.indexOf(':', firstColon + 1);
  if (firstColon <= 0 || secondColon <= firstColon + 1) {
    return undefined;
  }
  const kind = Number(address.slice(0, firstColon));
  const author = address.slice(firstColon + 1, secondColon);
  const d = address.slice(secondColon + 1);
  if (!Number.isSafeInteger(kind) || !/^[0-9a-f]{64}$/.test(author) || !D_TAG_RE.test(d)) {
    return undefined;
  }
  return { kind, author, d };
}

function isVisibility(value: string): value is Visibility {
  return VISIBILITIES.some((visibility) => visibility === value);
}

function readOptions(tags: NostrEvent['tags']): CatalogOption[] {
  const options: CatalogOption[] = [];
  for (const tag of tagsNamed(tags, 'option').slice(0, LIMITS.MAX_OPTIONS)) {
    const name = tag[1];
    if (!name || name.length > LIMITS.ATTR_NAME_CHARS) {
      continue;
    }
    const values = tag
      .slice(2)
      .filter((value) => value.length > 0 && value.length <= LIMITS.ATTR_VALUE_CHARS)
      .slice(0, LIMITS.MAX_OPTION_VALUES);
    options.push({ name, values });
  }
  return options;
}

/**
 * Variants that satisfy the 2.1 invariant: one value per option, each in that
 * option's values or `*`. Anything else is dropped, never repaired.
 */
function readVariants(tags: NostrEvent['tags'], options: CatalogOption[]): CatalogVariant[] {
  const variants: CatalogVariant[] = [];
  for (const tag of tagsNamed(tags, 'variant').slice(0, LIMITS.MAX_VARIANTS)) {
    const [, id, price, availableFlag, ...values] = tag;
    if (!id || id.length > LIMITS.ATTR_VALUE_CHARS || !price || !PRICE_AMOUNT_RE.test(price)) {
      continue;
    }
    if (availableFlag !== '0' && availableFlag !== '1') {
      continue;
    }
    if (values.length !== options.length) {
      continue;
    }
    const consistent = values.every((value, index) => {
      const option = options[index];
      return value === ANY_OPTION_VALUE || (option !== undefined && option.values.includes(value));
    });
    if (!consistent) {
      continue;
    }
    variants.push({ id, price, available: availableFlag === '1', values });
  }
  return variants;
}

/**
 * Read a 30402 listing for ComCore, or `undefined` when it is not shown:
 * unreadable by `parseProduct`, `hidden`, an unknown visibility, or expired.
 * The caller has checked the signature and that the author is authorized.
 */
export interface ParseCatalogItemOptions {
  now?: number;
  /**
   * The role of the listing's author, required so no caller can forget it: a
   * `catalog` key K never publishes payment tags (1.1), so a K listing that
   * carries `accept` is dropped.
   */
  role: CatalogKeyRole;
}

export function parseCatalogItem(
  event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags' | 'content' | 'created_at'>,
  parseOptions: ParseCatalogItemOptions,
): CatalogItem | undefined {
  const now = parseOptions.now ?? nowSecs();
  const product = parseProduct(event);
  if (!product) {
    return undefined;
  }
  if (parseOptions.role === 'catalog' && product.accept.length > 0) {
    return undefined;
  }
  const expiration = tagsNamed(event.tags, 'expiration');
  if (expiration.length > 0) {
    const value = expiration[0]?.[1] ?? '';
    if (expiration.length > 1 || !/^\d{1,12}$/.test(value) || Number(value) <= now) {
      return undefined;
    }
  }
  if (!isVisibility(product.visibility) || product.visibility === 'hidden') {
    return undefined;
  }
  const attrs: CatalogAttr[] = [];
  let sku: string | undefined;
  let sourceId: string | undefined;
  for (const tag of tagsNamed(event.tags, 'attr')) {
    const name = tag[1];
    const value = tag[2];
    if (!name || value === undefined || name.length > LIMITS.ATTR_NAME_CHARS) {
      continue;
    }
    if (value.length === 0 || value.length > LIMITS.ATTR_VALUE_CHARS) {
      continue;
    }
    if (name === 'sku') {
      sku ??= value;
    } else if (name === 'source-id') {
      sourceId ??= value;
    } else if (attrs.length < LIMITS.MAX_ATTRS) {
      attrs.push({ name, value });
    }
  }
  const options = readOptions(event.tags);
  const item: CatalogItem = {
    author: event.pubkey,
    d: product.d,
    address: catalogAddress(event.pubkey, product.d),
    title: product.title,
    description: product.description,
    price: product.price,
    priceFrom: tagValues(event.tags, 'price-from').includes('1'),
    images: product.images.slice(0, LIMITS.MAX_IMAGES),
    topics: product.topics.slice(0, LIMITS.MAX_TOPICS),
    links: tagValues(event.tags, 'r').filter((link) => link.startsWith('https://')),
    attrs,
    options,
    variants: readVariants(event.tags, options),
    visibility: product.visibility,
    hasAccept: product.accept.length > 0,
    createdAt: event.created_at,
  };
  if (product.summary !== undefined) {
    item.summary = product.summary;
  }
  if (sku !== undefined) {
    item.sku = sku;
  }
  if (sourceId !== undefined) {
    item.sourceId = sourceId;
  }
  return item;
}

/** The product page: the first `r` link on one of the allowed origins (K12), or none. */
export function productPageUrl(
  item: Pick<CatalogItem, 'links'>,
  allowedOrigins: readonly string[],
): string | undefined {
  for (const link of item.links) {
    try {
      if (allowedOrigins.includes(new URL(link).origin)) {
        return link;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

const attrSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(LIMITS.ATTR_NAME_CHARS)
    .refine((name) => !RESERVED_ATTRS.includes(name), 'reserved attr name'),
  value: z.string().min(1).max(LIMITS.ATTR_VALUE_CHARS),
});

const optionSchema = z.object({
  name: z.string().min(1).max(LIMITS.ATTR_NAME_CHARS),
  values: z
    .array(z.string().min(1).max(LIMITS.ATTR_VALUE_CHARS))
    .min(1)
    .max(LIMITS.MAX_OPTION_VALUES),
});

const variantSchema = z.object({
  id: z.string().min(1).max(LIMITS.ATTR_VALUE_CHARS),
  price: z.string().regex(PRICE_AMOUNT_RE),
  available: z.boolean(),
  values: z.array(z.string().min(1).max(LIMITS.ATTR_VALUE_CHARS)),
});

export const CatalogItemInputSchema = z
  .object({
    d: z.string().regex(D_TAG_RE),
    title: z.string().min(1).max(LIMITS.TAG_VALUE_CHARS),
    summary: z.string().max(LIMITS.TAG_VALUE_CHARS).optional(),
    description: z.string().max(LIMITS.DESCRIPTION_CHARS).default(''),
    price: z.object({
      amount: z.string().regex(PRICE_AMOUNT_RE),
      currency: z.string().regex(CURRENCY_RE),
      frequency: z.enum(FREQUENCIES).optional(),
    }),
    priceFrom: z.boolean().default(false),
    images: z
      .array(z.string().url().startsWith('https://').max(LIMITS.TAG_VALUE_CHARS))
      .max(LIMITS.MAX_IMAGES)
      .default([]),
    topics: z.array(z.string().min(1).max(LIMITS.TOPIC_CHARS)).max(LIMITS.MAX_TOPICS).default([]),
    url: z.string().url().startsWith('https://').max(LIMITS.TAG_VALUE_CHARS).optional(),
    sku: z.string().min(1).max(LIMITS.ATTR_VALUE_CHARS).optional(),
    sourceId: z.string().min(1).max(LIMITS.ATTR_VALUE_CHARS).optional(),
    attrs: z.array(attrSchema).max(LIMITS.MAX_ATTRS).default([]),
    options: z.array(optionSchema).max(LIMITS.MAX_OPTIONS).default([]),
    variants: z.array(variantSchema).max(LIMITS.MAX_VARIANTS).default([]),
    visibility: z.enum(VISIBILITIES).default('on-sale'),
    createdAt: z.number().int().positive().optional(),
  })
  .superRefine((input, context) => {
    const optionNames = input.options.map((option) => option.name);
    if (new Set(optionNames).size !== optionNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'option names must be unique',
      });
    }
    const variantIds = input.variants.map((variant) => variant.id);
    if (new Set(variantIds).size !== variantIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variants'],
        message: 'variant ids must be unique',
      });
    }
    // 2.1: with variants, the listing price is the lowest available variant's,
    // or the lowest overall when none is available (and then it is sold-out).
    if (input.variants.length > 0) {
      const available = input.variants.filter((variant) => variant.available);
      const pool = available.length > 0 ? available : input.variants;
      const lowest = pool
        .map((variant) => new Decimal(variant.price))
        .reduce((min, price) => (price.lessThan(min) ? price : min));
      if (!new Decimal(input.price.amount).equals(lowest)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['price', 'amount'],
          message: 'the price must be the lowest available variant price',
        });
      }
      if (available.length === 0 && input.visibility !== 'sold-out') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['visibility'],
          message: 'a listing with no available variant is sold-out',
        });
      }
    }
    input.variants.forEach((variant, variantIndex) => {
      if (variant.values.length !== input.options.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variants', variantIndex, 'values'],
          message: 'a variant needs exactly one value per option',
        });
        return;
      }
      variant.values.forEach((value, optionIndex) => {
        const option = input.options[optionIndex];
        if (value !== ANY_OPTION_VALUE && !option?.values.includes(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['variants', variantIndex, 'values', optionIndex],
            message: 'a variant value must be one of its option values, or *',
          });
        }
      });
    });
  });

export type CatalogItemInput = z.input<typeof CatalogItemInputSchema>;

/**
 * Build a ComCore 30402 listing: no payment tags, ever. The caller signs it
 * with an authorized catalog key K (never a Pay Core store key S).
 */
export function buildCatalogItemEvent(input: CatalogItemInput): EventTemplate {
  const item = CatalogItemInputSchema.parse(input);
  const tags: string[][] = [
    ['d', item.d],
    ['title', item.title],
  ];
  if (item.summary !== undefined) {
    tags.push(['summary', item.summary]);
  }
  tags.push(
    item.price.frequency === undefined
      ? ['price', item.price.amount, item.price.currency]
      : ['price', item.price.amount, item.price.currency, item.price.frequency],
  );
  if (item.priceFrom) {
    tags.push(['price-from', '1']);
  }
  for (const image of item.images) {
    tags.push(['image', image]);
  }
  for (const topic of item.topics) {
    tags.push(['t', topic]);
  }
  if (item.url !== undefined) {
    tags.push(['r', item.url]);
  }
  if (item.sku !== undefined) {
    tags.push(['attr', 'sku', item.sku]);
  }
  if (item.sourceId !== undefined) {
    tags.push(['attr', 'source-id', item.sourceId]);
  }
  for (const attr of item.attrs) {
    tags.push(['attr', attr.name, attr.value]);
  }
  for (const option of item.options) {
    tags.push(['option', option.name, ...option.values]);
  }
  for (const variant of item.variants) {
    tags.push([
      'variant',
      variant.id,
      variant.price,
      variant.available ? '1' : '0',
      ...variant.values,
    ]);
  }
  tags.push(['visibility', item.visibility]);
  return {
    kind: KIND_PRODUCT,
    created_at: item.createdAt ?? nowSecs(),
    tags,
    content: item.description,
  };
}

/**
 * The single variant a card pick determines, or none (7.4): exactly one kept
 * variant matches the picked values, and it has no `*`. A product with one
 * variant needs no pick.
 */
export function determinedVariant(
  item: Pick<CatalogItem, 'options' | 'variants'>,
  pick: Readonly<Record<string, string>>,
): CatalogVariant | undefined {
  const candidates =
    item.variants.length === 1
      ? item.variants
      : item.variants.filter((variant) =>
          item.options.every((option, index) => {
            const picked = pick[option.name];
            const value = variant.values[index];
            return picked !== undefined && (value === picked || value === ANY_OPTION_VALUE);
          }),
        );
  const [only] = candidates;
  if (candidates.length !== 1 || !only || only.values.includes(ANY_OPTION_VALUE)) {
    return undefined;
  }
  return only;
}
