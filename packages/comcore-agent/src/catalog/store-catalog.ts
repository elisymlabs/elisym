import {
  type CatalogItem,
  type Policy,
  RESERVED_ATTRS,
  type StoreConfig,
  type StorePrivateConfig,
  productPageUrl,
} from '@elisym/comcore';
import Decimal from 'decimal.js-light';
import { stripInvisible } from '../fence';

export const AVAILABILITY = ['in_stock', 'pre_order', 'sold_out'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/** In stock: on sale and, when it has variants, at least one available. */
export function availabilityOf(item: CatalogItem): Availability {
  if (item.visibility === 'sold-out') {
    return 'sold_out';
  }
  if (item.visibility === 'pre-order') {
    return 'pre_order';
  }
  if (item.variants.length > 0 && !item.variants.some((variant) => variant.available)) {
    return 'sold_out';
  }
  return 'in_stock';
}

/** Non-reserved attributes, the first `limit` of them. */
export function topAttrs(item: CatalogItem, limit: number): { name: string; value: string }[] {
  return item.attrs.filter((attr) => !RESERVED_ATTRS.includes(attr.name)).slice(0, limit);
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  // Catalog text and queries are normalized alike: an invisible soft hyphen never splits a term.
  return (stripInvisible(text.normalize('NFKC')).toLowerCase().match(TOKEN_RE) ?? []).filter(
    (token) => token.length > 1,
  );
}

interface IndexedItem {
  item: CatalogItem;
  terms: Map<string, number>;
  length: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * One store's catalog as the agent sees it: products in the store's currency
 * only (5.3), its policies, its config. Read-only; rebuilt when the relay data
 * changes.
 */
export class StoreCatalog {
  readonly items: ReadonlyMap<string, CatalogItem>;
  readonly policies: readonly Policy[];
  /** Listings dropped for another currency: the admin flags them (5.3). */
  readonly otherCurrency: readonly string[];
  private readonly indexed: IndexedItem[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(
    readonly config: StoreConfig,
    readonly privateConfig: StorePrivateConfig | undefined,
    items: readonly CatalogItem[],
    policies: readonly Policy[],
  ) {
    const byD = new Map<string, CatalogItem>();
    const otherCurrency: string[] = [];
    for (const item of items) {
      if (item.price.currency !== config.currency) {
        otherCurrency.push(item.d);
        continue;
      }
      byD.set(item.d, item);
    }
    this.items = byD;
    this.otherCurrency = otherCurrency;
    this.policies = policies;
    this.indexed = [...byD.values()].map((item) => {
      const tokens = tokenize(
        [
          item.title,
          item.summary ?? '',
          item.description,
          item.topics.join(' '),
          topAttrs(item, 30)
            .map((attr) => `${attr.name} ${attr.value}`)
            .join(' '),
          item.options.map((option) => `${option.name} ${option.values.join(' ')}`).join(' '),
        ].join(' '),
      );
      const terms = new Map<string, number>();
      for (const token of tokens) {
        terms.set(token, (terms.get(token) ?? 0) + 1);
      }
      for (const term of terms.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      return { item, terms, length: tokens.length };
    });
    const totalLength = this.indexed.reduce((sum, entry) => sum + entry.length, 0);
    this.averageLength = this.indexed.length > 0 ? totalLength / this.indexed.length : 0;
  }

  /** BM25 score of each item for `query`; items with no matching term score 0. */
  scores(query: string): Map<string, number> {
    const queryTerms = [...new Set(tokenize(query))];
    const documents = this.indexed.length;
    const result = new Map<string, number>();
    for (const entry of this.indexed) {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = entry.terms.get(term) ?? 0;
        if (frequency === 0) {
          continue;
        }
        const containing = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents - containing + 0.5) / (containing + 0.5));
        const norm =
          frequency +
          BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / Math.max(this.averageLength, 1));
        score += (idf * frequency * (BM25_K1 + 1)) / norm;
      }
      result.set(entry.item.d, score);
    }
    return result;
  }

  /** The product page link of an item on the store's allowed origins (K12). */
  pageUrl(item: CatalogItem): string | undefined {
    return productPageUrl(item, [...this.config.origins, ...this.config.linkOrigins]);
  }

  /** Item whose page is `url` (to resolve "this one" from the visitor's page, 4.2). */
  itemForPage(url: string | undefined): CatalogItem | undefined {
    if (url === undefined) {
      return undefined;
    }
    let target: string;
    try {
      const parsed = new URL(url);
      target = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return undefined;
    }
    for (const item of this.items.values()) {
      const page = this.pageUrl(item);
      if (page === undefined) {
        continue;
      }
      const parsedPage = new URL(page);
      if (`${parsedPage.origin}${parsedPage.pathname.replace(/\/$/, '')}` === target) {
        return item;
      }
    }
    return undefined;
  }
}

/** Compare listing prices exactly; subscriptions only with the same frequency (5.2). */
export function priceOf(item: CatalogItem): Decimal {
  return new Decimal(item.price.amount);
}
