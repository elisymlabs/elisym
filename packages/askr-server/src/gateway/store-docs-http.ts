import { createHash } from 'node:crypto';
import type { StoreCatalog } from '@elisym/askr-agent';
import { parseOwner } from '../cli';
import type { StoreDirectory } from '../state/stores';
import type { StoreStatus } from '../state/types';
import type { GatewayRequest } from './gateway';
import { WindowLimiter, ipKey } from './limits';
import {
  CATALOG_JSON_FILE,
  LLMS_TXT_FILE,
  STORE_DOCS_PREFIX,
  renderCatalogJson,
  renderLlmsTxt,
} from './store-docs';

/** Requests per IP (or IPv6 /64) per minute to the store files: an agent reads one or two. */
export const STORE_DOCS_PER_IP_PER_MINUTE = 60;
/** How long a store's rendered files (or its 404) are served from memory before its status is read again. */
export const STORE_DOCS_CACHE_TTL_MS = 120_000;
/** Stores kept rendered in memory at most, oldest first out. */
export const STORE_DOCS_MAX_CACHED = 1_024;
/** The rendered files kept in memory at most, in UTF-8 bytes (a store's two files are at most 4.5 MiB). */
export const STORE_DOCS_MAX_CACHED_BYTES = 64 * 1024 * 1024;
/**
 * Store IDs remembered as 404 at most, apart from the rendered stores, so a
 * run of made-up IDs never pushes a real store out of memory.
 */
export const STORE_DOCS_MAX_MISSES = 4_096;
/** What browsers and proxies may cache the files for. */
export const STORE_DOCS_MAX_AGE_SECS = 300;
/** A store whose catalog this instance has not loaded yet is asked again after this. */
const NOT_READY_RETRY_SECS = 30;
const MINUTE_MS = 60_000;
const ETAG_HEX_CHARS = 32;
const PATH_RE = /^\/s\/([^/]{1,128})\/([^/]{1,32})$/u;
const HEX_ANY_CASE_RE = /^[0-9a-fA-F]{64}$/u;

export interface StoreDocsDeps {
  /** The store's status in the directory; undefined for a store that does not exist. */
  statusOf: (owner: string) => Promise<StoreStatus | undefined>;
  /** The store's cached catalog, as the worker serves it (only active, leased stores have one). */
  catalogFor: (owner: string) => StoreCatalog | undefined;
  /** An active store read in full that has nothing to serve (no config, or one naming another assistant). */
  isUnservable: (owner: string) => boolean;
  /** The server's public base, no trailing slash: the files link to each other under it. */
  publicBase: string;
  /** Unix milliseconds. */
  nowMs?: () => number;
  /** The memory caps; tests lower them. */
  cacheLimits?: Partial<CacheLimits>;
}

export interface CacheLimits {
  maxCached: number;
  maxCachedBytes: number;
  maxMisses: number;
}

interface RenderedFile {
  body: string;
  etag: string;
}

/**
 * A number per catalog object the worker built, so a cached entry names the
 * catalog it was rendered from without holding it: a replaced catalog is
 * freed at once, not kept alive by the cache until its TTL.
 */
const CATALOG_VERSIONS = new WeakMap<StoreCatalog, number>();
let lastCatalogVersion = 0;

export function catalogVersionOf(catalog: StoreCatalog): number {
  const known = CATALOG_VERSIONS.get(catalog);
  if (known !== undefined) {
    return known;
  }
  lastCatalogVersion += 1;
  CATALOG_VERSIONS.set(catalog, lastCatalogVersion);
  return lastCatalogVersion;
}

interface FoundEntry {
  catalogVersion: number;
  llmsTxt: RenderedFile;
  catalogJson: RenderedFile;
  bytes: number;
  expiresAt: number;
}

type Lookup = { found: true; entry: FoundEntry } | { found: false } | 'not_ready';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'x-content-type-options': 'nosniff',
};

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

const NOT_FOUND_TEXT = 'No Askr store is published at this address.\n';

function rendered(body: string): RenderedFile {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  return { body, etag: `"${digest.slice(0, ETAG_HEX_CHARS)}"` };
}

/** The store's owner key from a path segment: an npub or 64 hex characters, else undefined. */
export function ownerOfStoreId(value: string): string | undefined {
  return parseOwner(HEX_ANY_CASE_RE.test(value) ? value.toLowerCase() : value);
}

/**
 * A store's status from the directory, without opening its keys: what the
 * public endpoint needs, and no more.
 */
export function statusFromDirectory(
  directory: Pick<StoreDirectory, 'statusOf'>,
): (owner: string) => Promise<StoreStatus | undefined> {
  return async (owner) => (await directory.statusOf(owner))?.status;
}

/**
 * Whether `If-None-Match` names this ETag: a list of tags, each strong or
 * weak (`W/`), or `*`.
 */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) {
    return false;
  }
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || tag.replace(/^W\//u, '') === etag);
}

/**
 * The rendered stores and the remembered 404s, apart. Every entry lives the
 * same TTL and is put in at the end, so the oldest, and every expired one,
 * are at the front: expired entries are dropped there on each use, then the
 * oldest while a cap is passed.
 */
class StoreDocsCache {
  private readonly found = new Map<string, FoundEntry>();
  private readonly misses = new Map<string, number>();
  private foundBytes = 0;

  constructor(private readonly limits: CacheLimits) {}

  private prune(now: number): void {
    for (const [owner, entry] of this.found) {
      if (entry.expiresAt > now) {
        break;
      }
      this.removeFound(owner, entry);
    }
    for (const [owner, expiresAt] of this.misses) {
      if (expiresAt > now) {
        break;
      }
      this.misses.delete(owner);
    }
  }

  private removeFound(owner: string, entry: FoundEntry): void {
    this.found.delete(owner);
    this.foundBytes -= entry.bytes;
  }

  /** The store's rendered files while fresh and of the catalog the worker holds now. */
  foundFor(owner: string, catalog: StoreCatalog | undefined, now: number): FoundEntry | undefined {
    this.prune(now);
    const entry = this.found.get(owner);
    return entry !== undefined &&
      entry.expiresAt > now &&
      catalog !== undefined &&
      entry.catalogVersion === catalogVersionOf(catalog)
      ? entry
      : undefined;
  }

  /** Whether the store is a remembered 404: only while the worker holds no catalog for it. */
  isMiss(owner: string, catalog: StoreCatalog | undefined, now: number): boolean {
    this.prune(now);
    const expiresAt = this.misses.get(owner);
    return catalog === undefined && expiresAt !== undefined && expiresAt > now;
  }

  putFound(owner: string, entry: FoundEntry, now: number): void {
    this.prune(now);
    const old = this.found.get(owner);
    if (old !== undefined) {
      this.removeFound(owner, old);
    }
    this.misses.delete(owner);
    for (const [first, oldest] of this.found) {
      if (
        this.found.size < this.limits.maxCached &&
        this.foundBytes + entry.bytes <= this.limits.maxCachedBytes
      ) {
        break;
      }
      this.removeFound(first, oldest);
    }
    this.found.set(owner, entry);
    this.foundBytes += entry.bytes;
  }

  putMiss(owner: string, expiresAt: number, now: number): void {
    this.prune(now);
    const old = this.found.get(owner);
    if (old !== undefined) {
      this.removeFound(owner, old);
    }
    this.misses.delete(owner);
    for (const first of this.misses.keys()) {
      if (this.misses.size < this.limits.maxMisses) {
        break;
      }
      this.misses.delete(first);
    }
    this.misses.set(owner, expiresAt);
  }
}

/**
 * The public, read-only store files for AI agents: `GET /s/<npub|hex>/llms.txt`
 * (Markdown) and `GET /s/<npub|hex>/catalog.json`. Served only for an active
 * store, from the catalog the worker already holds in memory: no relay read
 * and no model call per request. Rendered once per store and kept for
 * `STORE_DOCS_CACHE_TTL_MS` (or until the worker's catalog changes), under a
 * per-IP limit. Undefined for any path outside `/s/`.
 */
export function createStoreDocs(
  deps: StoreDocsDeps,
): (input: GatewayRequest) => Promise<Response | undefined> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const perIp = new WindowLimiter(STORE_DOCS_PER_IP_PER_MINUTE, MINUTE_MS);
  const cache = new StoreDocsCache({
    maxCached: deps.cacheLimits?.maxCached ?? STORE_DOCS_MAX_CACHED,
    maxCachedBytes: deps.cacheLimits?.maxCachedBytes ?? STORE_DOCS_MAX_CACHED_BYTES,
    maxMisses: deps.cacheLimits?.maxMisses ?? STORE_DOCS_MAX_MISSES,
  });

  const lookup = async (owner: string): Promise<Lookup> => {
    const now = nowMs();
    const catalog = deps.catalogFor(owner);
    const cached = cache.foundFor(owner, catalog, now);
    if (cached !== undefined) {
      return { found: true, entry: cached };
    }
    if (cache.isMiss(owner, catalog, now)) {
      return { found: false };
    }
    const status = await deps.statusOf(owner);
    const expiresAt = now + STORE_DOCS_CACHE_TTL_MS;
    if (status !== 'active' || (catalog === undefined && deps.isUnservable(owner))) {
      cache.putMiss(owner, expiresAt, now);
      return { found: false };
    }
    if (catalog === undefined) {
      // Active, but its catalog is not loaded here yet (a relay outage at boot).
      return 'not_ready';
    }
    const input = { catalog, publicBase: deps.publicBase };
    const llmsTxt = rendered(renderLlmsTxt(input));
    const catalogJson = rendered(renderCatalogJson(input));
    const entry: FoundEntry = {
      catalogVersion: catalogVersionOf(catalog),
      llmsTxt,
      catalogJson,
      bytes: Buffer.byteLength(llmsTxt.body, 'utf8') + Buffer.byteLength(catalogJson.body, 'utf8'),
      expiresAt,
    };
    cache.putFound(owner, entry, now);
    return { found: true, entry };
  };

  return async ({ request, clientAddress }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(STORE_DOCS_PREFIX)) {
      return undefined;
    }
    const method = request.method;
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, 'access-control-max-age': '600' },
      });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return text('Only GET is served here.\n', 405, { allow: 'GET, HEAD, OPTIONS' });
    }
    const match = PATH_RE.exec(url.pathname);
    const file = match?.[2];
    if (match === null || (file !== LLMS_TXT_FILE && file !== CATALOG_JSON_FILE)) {
      return text(NOT_FOUND_TEXT, 404);
    }
    const owner = ownerOfStoreId(match[1] ?? '');
    if (owner === undefined) {
      return text('The store ID must be an npub or a 64-character hex key.\n', 400);
    }
    if (!perIp.hit(ipKey(clientAddress), nowMs())) {
      return text('Too many requests. Try again in a minute.\n', 429, { 'retry-after': '60' });
    }
    const found = await lookup(owner);
    if (found === 'not_ready') {
      return text('This store is starting. Try again shortly.\n', 503, {
        'retry-after': String(NOT_READY_RETRY_SECS),
      });
    }
    if (!found.found) {
      return text(NOT_FOUND_TEXT, 404);
    }
    const served = file === LLMS_TXT_FILE ? found.entry.llmsTxt : found.entry.catalogJson;
    const headers = {
      ...CORS_HEADERS,
      'content-type':
        file === LLMS_TXT_FILE ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${STORE_DOCS_MAX_AGE_SECS}`,
      etag: served.etag,
    };
    if (matchesEtag(request.headers.get('if-none-match'), served.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(method === 'HEAD' ? null : served.body, { status: 200, headers });
  };
}
