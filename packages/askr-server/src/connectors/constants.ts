/** Sent on every connector request so a merchant can recognize (and allowlist) Askr. */
export const CONNECTOR_USER_AGENT = 'AskrConnector/0.1 (+https://api.askr.elisym.network)';

/** Redirects followed per request, each re-checked by the fetch guard (7.4). */
export const MAX_REDIRECTS = 3;
/** One page of a platform's product list, or one variation batch. */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** A whole Google Merchant feed. */
export const MAX_FEED_BYTES = 32 * 1024 * 1024;
/** A home page or `/.well-known/askr`, read for verification only. */
export const MAX_VERIFICATION_BYTES = 2 * 1024 * 1024;
/** Total time for one request including its redirects. */
export const FETCH_TIMEOUT_MS = 30_000;
/** A feed is one large file; it gets longer. */
export const FEED_TIMEOUT_MS = 120_000;

export const SHOPIFY_PAGE_SIZE = 250;
export const SHOPIFY_MAX_PAGES = 40;
export const WOO_PAGE_SIZE = 100;
export const WOO_MAX_PAGES = 100;
/** Variations read per Store API request (`type=variation&include=...`). */
export const WOO_VARIATION_BATCH = 100;
/** Requests one sync may make to a shop, variation reads included. */
export const MAX_REQUESTS_PER_SYNC = 2_000;

/** Default gap between two requests to the same shop origin (per-shop rate limit). */
export const DEFAULT_SHOP_GAP_MS = 500;

/** Scheduler backoff: a failing store waits its interval times 2^failures, at most this. */
export const MAX_SYNC_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Runs the scheduler lets overlap across stores. */
export const DEFAULT_MAX_CONCURRENT_SYNCS = 2;

/** Bytes of SHA-256 kept for a hashed `d` (7.4): 16 base64url characters. */
export const D_HASH_BYTES = 12;

/** Shopify policy pages imported as 30495 (7.4), by their public handle. */
export const SHOPIFY_POLICY_SLUGS: ReadonlyArray<{
  handle: string;
  slug: string;
}> = [
  { handle: 'refund-policy', slug: 'returns' },
  { handle: 'shipping-policy', slug: 'shipping' },
  { handle: 'privacy-policy', slug: 'privacy' },
  { handle: 'terms-of-service', slug: 'terms' },
];
