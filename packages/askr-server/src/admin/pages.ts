import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { GatewayRequest } from '../gateway/gateway';

/** Where the admin app is served (7.3): `https://api.askr.elisym.network/admin/`. */
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
 * reads from the relay. Images may come from any https host (store avatars
 * and product images the merchant pastes).
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
      return new Response(null, { status: 308, headers: { location: ADMIN_PAGES_PREFIX } });
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
