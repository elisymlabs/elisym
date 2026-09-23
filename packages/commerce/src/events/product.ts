import { type Asset, parseAssetAmount } from '@elisym/pay-core';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as nip19 from 'nostr-tools/nip19';
import { z } from 'zod';
import { parseCaip19 } from '../caip';
import {
  DELIVERY_METHODS,
  type DeliveryMethod,
  ELISYM_NETWORK_TAG,
  KIND_PRODUCT,
  LIMITS,
  PURCHASABLE_VISIBILITIES,
} from '../constants';
import { HEX_PUBKEY_RE, type Tags, nowSecs, tagValue, tagValues, tagsNamed } from '../tags';

const PRICE_AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const D_TAG_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const FREQUENCIES = ['hour', 'day', 'week', 'month', 'year'] as const;
const ENDPOINT_TYPES = ['x402', 'mpp'] as const;

/** USD-pegged coins a `USD` price is paid in at 1:1. */
const USD_STABLE_TOKENS: readonly string[] = ['usdc', 'usdce', 'pathusd'];

export type PriceFrequency = (typeof FREQUENCIES)[number];
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

export interface ProductPrice {
  /** Decimal string, exactly as published: never a float. */
  amount: string;
  /** ISO 4217, e.g. `USD`. */
  currency: string;
  /** Subscriptions only (NIP-99). */
  frequency?: PriceFrequency;
}

export interface Product {
  storePubkey: string;
  d: string;
  title: string;
  summary?: string;
  description: string;
  price: ProductPrice;
  images: string[];
  topics: string[];
  /** Gamma Markets visibility; absent means on sale. */
  visibility: string;
  delivery?: DeliveryMethod;
  /** Opted into the elisym aggregator (`["network", "elisym"]`). */
  listedOnElisym: boolean;
  /** HTTP 402 entry points for agents. Never trusted on their own: a challenge must pay a 10133 address. */
  endpoints: { type: EndpointType; url: string }[];
  /** CAIP-19 ids of the assets the store accepts. Addresses come from the owner's 10133 only. */
  accept: string[];
  createdAt: number;
}

const ProductInputSchema = z.object({
  d: z.string().regex(D_TAG_RE),
  title: z.string().min(1).max(LIMITS.MAX_TAG_VALUE_LENGTH),
  summary: z.string().max(LIMITS.MAX_TAG_VALUE_LENGTH).optional(),
  description: z.string().max(LIMITS.MAX_CONTENT_LENGTH),
  price: z.object({
    amount: z.string().regex(PRICE_AMOUNT_RE),
    currency: z.string().regex(CURRENCY_RE),
    frequency: z.enum(FREQUENCIES).optional(),
  }),
  images: z.array(z.string().url().max(LIMITS.MAX_TAG_VALUE_LENGTH)).default([]),
  topics: z.array(z.string().min(1).max(64)).default([]),
  visibility: z.string().min(1).max(32).default('on-sale'),
  delivery: z.enum(DELIVERY_METHODS).optional(),
  listedOnElisym: z.boolean().default(false),
  endpoints: z
    .array(z.object({ type: z.enum(ENDPOINT_TYPES), url: z.string().url().startsWith('https://') }))
    .default([]),
  accept: z.array(z.string()).min(1),
  createdAt: z.number().int().positive().optional(),
});

export type ProductInput = z.input<typeof ProductInputSchema>;

/** Build a kind 30402 listing. The caller signs it with the STORE key. */
export function buildProductEvent(input: ProductInput): EventTemplate {
  const product = ProductInputSchema.parse(input);
  for (const caip19 of product.accept) {
    if (!parseCaip19(caip19)) {
      throw new Error(`Not a payable CAIP-19 asset: ${caip19}`);
    }
  }
  const tags: string[][] = [
    ['d', product.d],
    ['title', product.title],
  ];
  if (product.summary !== undefined) {
    tags.push(['summary', product.summary]);
  }
  tags.push(
    product.price.frequency === undefined
      ? ['price', product.price.amount, product.price.currency]
      : ['price', product.price.amount, product.price.currency, product.price.frequency],
  );
  for (const image of product.images) {
    tags.push(['image', image]);
  }
  for (const topic of product.topics) {
    tags.push(['t', topic]);
  }
  tags.push(['visibility', product.visibility]);
  if (product.delivery !== undefined) {
    tags.push(['delivery', product.delivery]);
  }
  if (product.listedOnElisym) {
    tags.push(['network', ELISYM_NETWORK_TAG]);
  }
  for (const endpoint of product.endpoints) {
    tags.push(['endpoint', endpoint.type, endpoint.url]);
  }
  for (const caip19 of product.accept) {
    tags.push(['accept', caip19]);
  }
  return {
    kind: KIND_PRODUCT,
    created_at: product.createdAt ?? nowSecs(),
    tags,
    content: product.description,
  };
}

function parsePrice(tags: Tags): ProductPrice | undefined {
  const tag = tagsNamed(tags, 'price')[0];
  const amount = tag?.[1];
  const currency = tag?.[2];
  const frequency = tag?.[3];
  if (!amount || !PRICE_AMOUNT_RE.test(amount) || !currency || !CURRENCY_RE.test(currency)) {
    return undefined;
  }
  if (frequency === undefined || frequency === '') {
    return { amount, currency };
  }
  const known = FREQUENCIES.find((candidate) => candidate === frequency);
  return known ? { amount, currency, frequency: known } : undefined;
}

/**
 * Read a kind 30402 listing, or `undefined` when it lacks what a sale needs (a
 * `d`, a title, a price). Unknown extras are ignored, so a plain NIP-99 listing
 * from another client still reads - it just accepts nothing elisym can pay.
 * The caller has checked the signature.
 */
export function parseProduct(
  event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags' | 'content' | 'created_at'>,
): Product | undefined {
  if (event.kind !== KIND_PRODUCT || event.content.length > LIMITS.MAX_CONTENT_LENGTH) {
    return undefined;
  }
  const tags = event.tags;
  const d = tagValue(tags, 'd');
  const title = tagValue(tags, 'title');
  const price = parsePrice(tags);
  if (d === undefined || !D_TAG_RE.test(d) || !title || !price) {
    return undefined;
  }
  const deliveryValue = tagValue(tags, 'delivery');
  const delivery = DELIVERY_METHODS.find((method) => method === deliveryValue);
  const endpoints: Product['endpoints'] = [];
  for (const tag of tagsNamed(tags, 'endpoint')) {
    const type = ENDPOINT_TYPES.find((candidate) => candidate === tag[1]);
    const url = tag[2];
    if (type && url?.startsWith('https://')) {
      endpoints.push({ type, url });
    }
  }
  const summary = tagValue(tags, 'summary');
  const product: Product = {
    storePubkey: event.pubkey,
    d,
    title,
    description: event.content,
    price,
    images: tagValues(tags, 'image'),
    topics: tagValues(tags, 't'),
    visibility: tagValue(tags, 'visibility') ?? 'on-sale',
    listedOnElisym: tagValues(tags, 'network').includes(ELISYM_NETWORK_TAG),
    endpoints,
    accept: tagValues(tags, 'accept'),
    createdAt: event.created_at,
  };
  if (summary !== undefined) {
    product.summary = summary;
  }
  if (delivery !== undefined) {
    product.delivery = delivery;
  }
  return product;
}

export function isPurchasable(product: Pick<Product, 'visibility'>): boolean {
  return PURCHASABLE_VISIBILITIES.some((visibility) => visibility === product.visibility);
}

/** `30402:<store>:<d>`, the address an order's `item` tag names. */
export function productAddress(product: Pick<Product, 'storePubkey' | 'd'>): string {
  return `${KIND_PRODUCT}:${product.storePubkey}:${product.d}`;
}

export function encodeProductNaddr(
  product: Pick<Product, 'storePubkey' | 'd'>,
  relays: string[] = [],
): string {
  return nip19.naddrEncode({
    kind: KIND_PRODUCT,
    pubkey: product.storePubkey,
    identifier: product.d,
    relays,
  });
}

export interface ProductPointer {
  storePubkey: string;
  d: string;
  relays: string[];
}

/** Decode a product `naddr`, or `undefined` when it is not one. */
export function decodeProductNaddr(naddr: string): ProductPointer | undefined {
  try {
    const decoded = nip19.decode(naddr);
    if (
      decoded.type !== 'naddr' ||
      decoded.data.kind !== KIND_PRODUCT ||
      !HEX_PUBKEY_RE.test(decoded.data.pubkey) ||
      !D_TAG_RE.test(decoded.data.identifier)
    ) {
      return undefined;
    }
    return {
      storePubkey: decoded.data.pubkey,
      d: decoded.data.identifier,
      relays: decoded.data.relays ?? [],
    };
  } catch {
    return undefined;
  }
}

/**
 * The price in `asset` subunits. Only a one-off `USD` price paid in a USD-pegged
 * coin at 1:1 has one; any other pairing needs a quote (quoted mode), so it is
 * refused here rather than converted at a guessed rate.
 */
export function priceInSubunits(price: ProductPrice, asset: Asset): bigint {
  if (price.frequency !== undefined) {
    throw new Error('A subscription price has no one-off amount');
  }
  if (price.currency !== 'USD' || !USD_STABLE_TOKENS.includes(asset.token)) {
    throw new Error(`A ${price.currency} price cannot be paid in ${asset.symbol} without a quote`);
  }
  return parseAssetAmount(asset, price.amount);
}
