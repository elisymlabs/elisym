import {
  type CatalogItemInput,
  type ConnectorPlatform,
  type SyncDiff,
  type SyncRelayClient,
  syncCatalog,
} from '@elisym/askr';
import { SHOPIFY_POLICY_SLUGS } from './constants';
import { type FetchGuardDeps, FetchGuardError, checkUrl } from './fetch-guard';
import { fetchGoogleFeed, mapGoogleItem } from './google-feed';
import { ShopHttp, type ShopRateLimiter, SourceClosedError } from './http';
import { type FitResult, type ProductDraft, fitDraft } from './listing';
import { type PolicyDiff, syncImportedPolicies } from './policies';
import {
  fetchShopifyCurrency,
  fetchShopifyPolicies,
  fetchShopifyProducts,
  mapShopifyProduct,
} from './shopify';
import { type VerificationFailure, verifyOrigins } from './verification';
import { fetchWooProducts, fetchWooVariations, mapWooProduct } from './woocommerce';

export interface SkippedProduct {
  sourceId: string;
  reason: string;
}

export type ConnectorSyncResult =
  | {
      status: 'ok';
      diff: SyncDiff;
      /** `d` of every listing cut to the 2.1 caps: flagged "truncated" in the admin. */
      truncated: string[];
      skipped: SkippedProduct[];
      /** Shopify only, when policies are imported. */
      policies?: PolicyDiff;
      /** Set when the policy import failed; the catalog sync itself went through. */
      policyError?: string;
      /** Only on a dry run: the listings a real sync would publish (the first-import preview). */
      items?: CatalogItemInput[];
    }
  | { status: 'verification_failed'; failures: VerificationFailure[] }
  | {
      status: 'source_closed';
      url: string;
      reason: string;
      httpStatus?: number;
    }
  | { status: 'error'; message: string };

export interface ConnectorSyncOptions {
  platform: ConnectorPlatform;
  /** The shop URL (Shopify, WooCommerce) or the feed URL (Google). */
  url: string;
  /** The store owner O (hex): the npub verification looks for. */
  owner: string;
  /** The store's server K, 30497-authorized by O; signs listings and imported policies. */
  serverKey: Uint8Array;
  client: SyncRelayClient;
  /** The store config's `origin` and `link-origin` entries. */
  origins: readonly string[];
  fetch?: FetchGuardDeps;
  /** Share one across syncs: the per-shop rate limit. */
  limiter?: ShopRateLimiter;
  maxRequests?: number;
  /** Overrides the Shopify shop currency read from `/meta.json`. */
  currency?: string;
  /** Shopify: import the refund/shipping/privacy/terms pages as policies (default true). */
  importPolicies?: boolean;
  dryRun?: boolean;
  /** The tier's products indexed at most (9): a larger catalog is not synced. */
  maxItems?: number;
  /** Unix seconds. */
  now?: number;
  pace?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface FetchedCatalog {
  drafts: ProductDraft[];
  skipped: SkippedProduct[];
  /** Products a platform mapper already had to cut something from. */
  lossy: Set<string>;
}

/** Shopify lives at the origin; a Woo shop may live under a path (`https://host/shop`). */
function shopBase(platform: ConnectorPlatform, url: URL): string {
  if (platform === 'shopify') {
    return url.origin;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

async function fetchShopify(
  http: ShopHttp,
  origin: string,
  currencyOverride: string | undefined,
): Promise<FetchedCatalog> {
  const { products, malformed } = await fetchShopifyProducts(http, origin);
  const currency = currencyOverride ?? (await fetchShopifyCurrency(http, origin));
  if (currency === undefined) {
    throw new Error('The shop currency is unknown: set it in the connector settings');
  }
  return {
    drafts: products.map((product) => mapShopifyProduct(product, { origin, currency })),
    skipped: malformedSkips(malformed),
    lossy: new Set(),
  };
}

async function fetchWoo(http: ShopHttp, base: string, origin: string): Promise<FetchedCatalog> {
  const { products, malformed } = await fetchWooProducts(http, base);
  const variationIds = products
    .filter((product) => product.type === 'variable')
    .flatMap((product) => (product.variations ?? []).map((variation) => variation.id));
  const variations = await fetchWooVariations(http, base, variationIds);
  const catalog: FetchedCatalog = {
    drafts: [],
    skipped: malformedSkips(malformed),
    lossy: new Set(),
  };
  for (const product of products) {
    const mapped = mapWooProduct(product, variations, origin);
    if (!mapped.ok) {
      catalog.skipped.push({
        sourceId: mapped.sourceId,
        reason: mapped.reason,
      });
      continue;
    }
    if (mapped.missingVariations > 0) {
      catalog.lossy.add(mapped.draft.sourceId);
    }
    catalog.drafts.push(mapped.draft);
  }
  return catalog;
}

async function fetchGoogle(
  http: ShopHttp,
  feedUrl: string,
  nowMs: number,
): Promise<FetchedCatalog> {
  const items = await fetchGoogleFeed(http, feedUrl);
  const catalog: FetchedCatalog = { drafts: [], skipped: [], lossy: new Set() };
  for (const item of items) {
    const mapped = mapGoogleItem(item, nowMs);
    if (mapped.ok) {
      catalog.drafts.push(mapped.draft);
    } else {
      catalog.skipped.push({
        sourceId: mapped.sourceId,
        reason: mapped.reason,
      });
    }
  }
  return catalog;
}

function malformedSkips(count: number): SkippedProduct[] {
  return Array.from({ length: count }, () => ({
    sourceId: '',
    reason: 'malformed product',
  }));
}

function fitAll(catalog: FetchedCatalog): {
  items: CatalogItemInput[];
  truncated: string[];
  skipped: SkippedProduct[];
} {
  const items: CatalogItemInput[] = [];
  const truncated: string[] = [];
  const skipped = [...catalog.skipped];
  const seen = new Set<string>();
  for (const draft of catalog.drafts) {
    const fitted: FitResult = fitDraft(draft);
    if (!fitted.ok) {
      skipped.push({ sourceId: fitted.sourceId, reason: fitted.reason });
      continue;
    }
    if (seen.has(fitted.listing.d)) {
      skipped.push({
        sourceId: draft.sourceId,
        reason: 'duplicate product id',
      });
      continue;
    }
    seen.add(fitted.listing.d);
    items.push(fitted.listing);
    if (fitted.truncated || catalog.lossy.has(draft.sourceId)) {
      truncated.push(fitted.listing.d);
    }
  }
  return { items, truncated, skipped };
}

function originOf(link: string): string | undefined {
  try {
    return new URL(link).origin;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One connector sync (7.4): verify the domain, read the public catalog under
 * the fetch guards and per-shop limits, fit it to the 2.1 caps and bring the
 * server K's listings in line through `syncCatalog` (only previewed on a dry
 * run). Nothing is published unless the whole catalog was read and verified.
 */
export async function syncConnector(options: ConnectorSyncOptions): Promise<ConnectorSyncResult> {
  const http = new ShopHttp({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.limiter ? { limiter: options.limiter } : {}),
    ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
  });
  const nowSecs = options.now ?? Math.floor(Date.now() / 1000);
  try {
    const url = checkUrl(options.url);
    const configured = options.origins.map((origin) => originOf(origin) ?? origin);
    let catalog: FetchedCatalog;
    if (options.platform === 'google') {
      catalog = await fetchGoogle(http, url.toString(), nowSecs * 1000);
    } else {
      // Shopify/Woo: the shop's own origin, one of the config's (its product pages are the
      // listings' links, K12) and verified before anything is read.
      const failures = await verifyOrigins(http, [url.origin], configured, options.owner);
      if (failures.length > 0) {
        return { status: 'verification_failed', failures };
      }
      catalog =
        options.platform === 'shopify'
          ? await fetchShopify(http, url.origin, options.currency)
          : await fetchWoo(http, shopBase(options.platform, url), url.origin);
    }
    const { items, truncated, skipped } = fitAll(catalog);
    if (options.maxItems !== undefined && items.length > options.maxItems) {
      return {
        status: 'error',
        message: `${items.length} products, over the tier's ${options.maxItems}`,
      };
    }
    if (options.platform === 'google') {
      // A feed: every product link origin must be a configured, verified origin.
      const linkOrigins = items
        .map((item) => (item.url === undefined ? undefined : originOf(item.url)))
        .filter((origin) => origin !== undefined);
      const failures = await verifyOrigins(http, linkOrigins, configured, options.owner);
      if (failures.length > 0) {
        return { status: 'verification_failed', failures };
      }
    }
    const diff = await syncCatalog({
      signer: options.serverKey,
      store: options.owner,
      items,
      client: options.client,
      now: nowSecs,
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.pace === undefined ? {} : { pace: options.pace }),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    const result: ConnectorSyncResult = {
      status: 'ok',
      diff,
      truncated,
      skipped,
    };
    if (options.dryRun) {
      result.items = items;
    }
    if (options.platform === 'shopify' && options.importPolicies !== false) {
      try {
        const policies = await fetchShopifyPolicies(http, url.origin);
        result.policies = await syncImportedPolicies({
          signer: options.serverKey,
          store: options.owner,
          client: options.client,
          policies,
          managedSlugs: SHOPIFY_POLICY_SLUGS.map((entry) => entry.slug),
          now: nowSecs,
          ...(options.dryRun ? { dryRun: true } : {}),
        });
      } catch (error) {
        result.policyError = errorMessage(error);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof SourceClosedError) {
      return {
        status: 'source_closed',
        url: error.url,
        reason: error.reason,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      };
    }
    if (error instanceof FetchGuardError) {
      return { status: 'error', message: `${error.code}: ${error.message}` };
    }
    return { status: 'error', message: errorMessage(error) };
  }
}
