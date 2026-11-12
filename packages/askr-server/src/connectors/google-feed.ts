import type { CatalogAttr, Visibility } from '@elisym/askr';
import { FEED_TIMEOUT_MS, MAX_FEED_BYTES } from './constants';
import { htmlToText, inlineText } from './html';
import type { ShopHttp } from './http';
import { SourceClosedError } from './http';
import { type ProductDraft, normalizeAmount } from './listing';
import { type XmlElement, XmlParseError, parseXml } from './xml';

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

const GOOGLE_NS = 'http://base.google.com/ns/1.0';
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const CLOSED_STATUSES = new Set([401, 403, 404]);

/** One feed item: attribute name (no `g:` prefix) to its values in feed order. */
export type GoogleFeedItem = Map<string, string[]>;

// cspell:ignore backorder preorder gtin
const AVAILABILITY: Readonly<Record<string, Visibility>> = {
  in_stock: 'on-sale',
  backorder: 'on-sale',
  preorder: 'pre-order',
  out_of_stock: 'sold-out',
};

/** Feed attributes copied to `attr` tags, under the same name. */
const ATTR_FIELDS = [
  'brand',
  'gtin',
  'mpn',
  'condition',
  'color',
  'size',
  'material',
  'pattern',
  'gender',
  'age_group',
] as const;

export class FeedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedFormatError';
  }
}

function addField(item: GoogleFeedItem, name: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed === '') {
    return;
  }
  const values = item.get(name);
  if (values) {
    values.push(trimmed);
  } else {
    item.set(name, [trimmed]);
  }
}

/**
 * Fields of an RSS `<item>` or Atom `<entry>`. A Google-namespace field wins
 * over a plain RSS/Atom one of the same name (e.g. `g:link` over `link`);
 * Atom `<link href>` and `<summary>` are read as `link` and `description`.
 */
function itemFields(element: XmlElement): GoogleFeedItem {
  const google: GoogleFeedItem = new Map();
  const plain: GoogleFeedItem = new Map();
  for (const child of element.children) {
    if (child.children.length > 0) {
      continue;
    }
    if (child.namespace === GOOGLE_NS) {
      addField(google, child.localName, child.text);
    } else if (child.namespace === undefined || child.namespace === ATOM_NS) {
      if (child.localName === 'link') {
        addField(plain, 'link', child.attrs.get('href') ?? child.text);
      } else if (child.localName === 'summary' || child.localName === 'content') {
        addField(plain, 'description', child.text);
      } else {
        addField(plain, child.localName, child.text);
      }
    }
  }
  for (const [name, values] of plain) {
    if (!google.has(name)) {
      google.set(name, values);
    }
  }
  return google;
}

function collectItems(root: XmlElement): XmlElement[] {
  if (root.localName === 'feed') {
    return root.children.filter((child) => child.localName === 'entry');
  }
  if (root.localName === 'rss') {
    return root.children
      .filter((child) => child.localName === 'channel')
      .flatMap((channel) => channel.children.filter((child) => child.localName === 'item'));
  }
  throw new FeedFormatError('Neither an RSS 2.0 nor an Atom feed');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  return trimmed;
}

function headerName(raw: string): string {
  return unquote(raw)
    .toLowerCase()
    .replace(/^g:/u, '')
    .replace(/[\s-]+/gu, '_');
}

/** Fields a TSV feed packs comma-separated into one cell. */
const LIST_FIELDS = new Set(['additional_image_link']);

function parseTsv(body: string): GoogleFeedItem[] {
  const lines = body.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const [header, ...rows] = lines;
  if (header === undefined) {
    throw new FeedFormatError('Empty feed');
  }
  const columns = header.split('\t').map((column) => headerName(column));
  if (!columns.includes('id')) {
    throw new FeedFormatError('A TSV feed needs an id column');
  }
  return rows.map((row) => {
    const item: GoogleFeedItem = new Map();
    row.split('\t').forEach((cell, index) => {
      const name = columns[index];
      if (name === undefined) {
        return;
      }
      const value = unquote(cell);
      const parts = LIST_FIELDS.has(name) ? value.split(',') : [value];
      for (const part of parts) {
        addField(item, name, part);
      }
    });
    return item;
  });
}

/** A Google Merchant feed (RSS 2.0, Atom or TSV) as raw items. */
export function parseGoogleFeed(body: string): GoogleFeedItem[] {
  const text = body.startsWith(BYTE_ORDER_MARK) ? body.slice(1) : body;
  if (text.trimStart().startsWith('<')) {
    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch (error) {
      if (error instanceof XmlParseError) {
        throw new FeedFormatError(`Malformed XML: ${error.message}`);
      }
      throw error;
    }
    return collectItems(root).map((element) => itemFields(element));
  }
  return parseTsv(text);
}

const PRICE_RE = /^(?:([A-Z]{3})\s+)?(\d+(?:\.\d+)?)(?:\s+([A-Z]{3}))?$/u;

/** `15.00 USD` (or `USD 15.00`) to an amount and currency. */
export function parseFeedPrice(raw: string): { amount: string; currency: string } | undefined {
  const match = PRICE_RE.exec(raw.trim());
  const currency = match?.[1] ?? match?.[3];
  const amount = match?.[2] === undefined ? undefined : normalizeAmount(match[2]);
  if (!match || currency === undefined || amount === undefined) {
    return undefined;
  }
  if (match[1] !== undefined && match[3] !== undefined) {
    return undefined;
  }
  return { amount, currency };
}

/** Whether `now` (ms) falls in a `start/end` ISO 8601 range; no range means always. */
function saleIsActive(range: string | undefined, nowMs: number): boolean {
  if (range === undefined) {
    return true;
  }
  const [start, end] = range.split('/');
  const startMs = start === undefined ? Number.NaN : Date.parse(start);
  const endMs = end === undefined ? Number.NaN : Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return false;
  }
  return nowMs >= startMs && nowMs < endMs;
}

export type GoogleMapResult =
  | { ok: true; draft: ProductDraft }
  | { ok: false; sourceId: string; reason: string };

/**
 * A feed item as a draft listing (7.4): `g:id` is both `source-id` and `sku`;
 * no variants (no native add-to-cart); `sale_price` replaces `price` while its
 * effective date range (if any) holds; availability to visibility.
 */
export function mapGoogleItem(item: GoogleFeedItem, nowMs: number): GoogleMapResult {
  const first = (name: string): string | undefined => item.get(name)?.[0];
  const sourceId = first('id');
  if (sourceId === undefined) {
    return { ok: false, sourceId: '', reason: 'no id' };
  }
  const regular = parseFeedPrice(first('price') ?? '');
  if (!regular) {
    return { ok: false, sourceId, reason: 'no valid price' };
  }
  const sale = parseFeedPrice(first('sale_price') ?? '');
  const price =
    sale &&
    sale.currency === regular.currency &&
    saleIsActive(first('sale_price_effective_date'), nowMs)
      ? sale
      : regular;
  const attrs: CatalogAttr[] = [];
  for (const field of ATTR_FIELDS) {
    for (const value of item.get(field) ?? []) {
      attrs.push({ name: field, value: inlineText(value) });
    }
  }
  const topics = [
    ...(item.get('product_type') ?? []),
    ...(item.get('google_product_category') ?? []),
  ]
    .map((topic) => inlineText(topic))
    .filter((topic) => !/^\d+$/u.test(topic));
  const availability = (first('availability') ?? '').toLowerCase().replace(/\s+/gu, '_');
  const draft: ProductDraft = {
    platform: 'google',
    sourceId,
    title: inlineText(first('title') ?? ''),
    description: htmlToText(first('description') ?? ''),
    currency: price.currency,
    images: [...(item.get('image_link') ?? []), ...(item.get('additional_image_link') ?? [])],
    topics,
    attrs,
    options: [],
    variants: [],
    price: price.amount,
    // Unknown availability is never recommended: shown only when asked about.
    visibility: AVAILABILITY[availability] ?? 'sold-out',
    sku: sourceId,
  };
  const link = first('link');
  if (link !== undefined) {
    draft.url = link;
  }
  return { ok: true, draft };
}

/** Fetch and parse the feed; a closed URL or a body that is no feed is a closed source. */
export async function fetchGoogleFeed(http: ShopHttp, feedUrl: string): Promise<GoogleFeedItem[]> {
  const response = await http.get(feedUrl, {
    maxBytes: MAX_FEED_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    accept:
      'application/rss+xml, application/atom+xml, application/xml, text/xml, text/tab-separated-values, text/plain',
  });
  if (CLOSED_STATUSES.has(response.status)) {
    throw new SourceClosedError(feedUrl, `HTTP ${response.status}`, response.status);
  }
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} from ${feedUrl}`);
  }
  try {
    return parseGoogleFeed(response.body);
  } catch (error) {
    if (error instanceof FeedFormatError) {
      throw new SourceClosedError(feedUrl, error.message, response.status);
    }
    throw error;
  }
}
