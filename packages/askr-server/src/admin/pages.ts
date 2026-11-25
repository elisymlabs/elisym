import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { GatewayRequest } from '../gateway/gateway';

/** Where the admin app is served (7.3): `https://app.askr.elisym.network/admin/`. */
export const ADMIN_PAGES_PREFIX = '/admin/';
const ADMIN_INDEX = `${ADMIN_PAGES_PREFIX}index.html`;
/** Vite's content-hashed output: safe to cache for good. */
const HASHED_ASSETS_PREFIX = `${ADMIN_PAGES_PREFIX}assets/`;
const IMMUTABLE_MAX_AGE_SECS = 365 * 24 * 60 * 60;
/** The admin build is small; a directory far larger than this is not it. */
const MAX_ADMIN_FILES = 500;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface AdminFile {
  body: Uint8Array;
  type: string;
}

/**
 * The built admin app, read once at startup into memory keyed by the path it
 * is served at, so a request path is only ever looked up, never joined onto
 * the disk. Files of a type not listed are left out.
 */
export function loadAdminFiles(dir: string): Map<string, AdminFile> {
  const files = new Map<string, AdminFile>();
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, entry);
    const type = CONTENT_TYPES[extname(entry).toLowerCase()];
    if (type === undefined || !statSync(path).isFile()) {
      continue;
    }
    if (files.size >= MAX_ADMIN_FILES) {
      throw new Error(`${dir} holds more than ${MAX_ADMIN_FILES} files: not the admin build`);
    }
    const servedAt = `${ADMIN_PAGES_PREFIX}${relative(dir, path).split(sep).join('/')}`;
    files.set(servedAt, { body: readFileSync(path), type });
  }
  if (!files.has(ADMIN_INDEX)) {
    throw new Error(`${dir} has no index.html: not the admin build`);
  }
  return files;
}

/**
 * The page's CSP: its own scripts and styles only, API calls to this origin,
 * reads from the relay. Images may come from any https host (the product
 * images the merchant pastes).
 */
export function adminCsp(relayUrl: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https: data:",
    "font-src 'self'",
    `connect-src 'self' ${new URL(relayUrl).origin}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Serves the admin app (7.3) under `/admin/`: a known file as is, any other
 * path without an extension as `index.html` (the app routes in the browser),
 * and `/admin` redirected to `/admin/`. Undefined for every other path.
 */
export function createAdminPages(
  files: ReadonlyMap<string, AdminFile>,
  relayUrl: string,
): (input: GatewayRequest) => Response | undefined {
  const csp = adminCsp(relayUrl);
  return ({ request }) => {
    const url = new URL(request.url);
    const isAdminPath = url.pathname === '/admin' || url.pathname.startsWith(ADMIN_PAGES_PREFIX);
    if (!isAdminPath) {
      return undefined;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/admin') {
      // The query is kept: the landing's plan choice (`?plan=&interval=`) must reach the admin.
      return new Response(null, {
        status: 308,
        headers: { location: `${ADMIN_PAGES_PREFIX}${url.search}` },
      });
    }
    // The embedded Shopify page is in the same build but served only at /shopify/ (5.1).
    if (url.pathname.startsWith(`${ADMIN_PAGES_PREFIX}shopify/`)) {
      return new Response('Not found', {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    const lastSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const path =
      url.pathname === ADMIN_PAGES_PREFIX || !lastSegment.includes('.')
        ? ADMIN_INDEX
        : url.pathname;
    const file = files.get(path);
    if (file === undefined) {
      return new Response('Not found', {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    const immutable = path.startsWith(HASHED_ASSETS_PREFIX);
    return new Response(request.method === 'HEAD' ? null : file.body, {
      status: 200,
      headers: {
        'content-type': file.type,
        'cache-control': immutable
          ? `public, max-age=${IMMUTABLE_MAX_AGE_SECS}, immutable`
          : 'no-cache',
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
      },
    });
  };
}

/** Where the Shopify app's embedded admin is served (askr-shopify 5.1). */
export const SHOPIFY_PAGES_PREFIX = '/shopify/';
/** The embedded admin's page in the admin build: a second Vite entry. */
export const SHOPIFY_INDEX = `${ADMIN_PAGES_PREFIX}shopify/index.html`;
/** What the build leaves in the page for the server to fill in: the app's client id. */
export const SHOPIFY_API_KEY_PLACEHOLDER = '__ASKR_SHOPIFY_API_KEY__';
/** App Bridge, loaded from Shopify's CDN as the page's first script (Shopify requires it). */
export const APP_BRIDGE_URL = 'https://cdn.shopify.com/shopifycloud/app-bridge.js';
const SHOPIFY_CDN = 'https://cdn.shopify.com';
const SHOPIFY_ADMIN_ORIGIN = 'https://admin.shopify.com';
const SHOP_PARAM_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u;

/**
 * The embedded page's CSP (askr-shopify 5.1): the admin's own files, App Bridge from Shopify's
 * CDN, API calls to this origin, reads from the relay; framed only by Shopify's admin and the
 * shop the `shop` parameter names (a malformed one names none).
 */
export function shopifyCsp(relayUrl: string, shop: string | null): string {
  const ancestors =
    shop !== null && SHOP_PARAM_RE.test(shop)
      ? `${SHOPIFY_ADMIN_ORIGIN} https://${shop}`
      : SHOPIFY_ADMIN_ORIGIN;
  return [
    "default-src 'none'",
    `script-src 'self' ${SHOPIFY_CDN}`,
    // App Bridge styles its own elements inline.
    `style-src 'self' 'unsafe-inline' ${SHOPIFY_CDN}`,
    "img-src 'self' https: data:",
    "font-src 'self'",
    `connect-src 'self' ${new URL(relayUrl).origin} ${SHOPIFY_CDN}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

/**
 * Serves the Shopify app's embedded admin under `/shopify/` (askr-shopify 5.1): the build's
 * `shopify/index.html` with the app's client id filled in, framed only by Shopify. Assets stay
 * under `/admin/assets/`. Undefined for every other path.
 */
export function createShopifyPage(
  files: ReadonlyMap<string, AdminFile>,
  relayUrl: string,
  apiKey: string,
): (input: GatewayRequest) => Response | undefined {
  const index = files.get(SHOPIFY_INDEX);
  if (index === undefined) {
    throw new Error('The admin build has no shopify/index.html: build @elisym/askr-admin again');
  }
  const html = new TextDecoder()
    .decode(index.body)
    .replaceAll(SHOPIFY_API_KEY_PLACEHOLDER, apiKey.replace(/[^A-Za-z0-9_-]/gu, ''));
  return ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname !== '/shopify' && !url.pathname.startsWith(SHOPIFY_PAGES_PREFIX)) {
      return undefined;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/shopify') {
      return new Response(null, {
        status: 308,
        headers: { location: `${SHOPIFY_PAGES_PREFIX}${url.search}` },
      });
    }
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-security-policy': shopifyCsp(relayUrl, url.searchParams.get('shop')),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  };
}
