/**
 * What this admin's `vercel.json` must hold, as pure functions: `check-build.ts`
 * runs them after `vite build`, and `tests/build-checks.test.ts` pins them.
 */
import { cspOf, cspProblems, cspSources, headerProblems } from './build-checks';

/** The self-host page and everything but `/hosted/`. */
export const SELF_HOST_SOURCE = '/((?!hosted/).*)';
/** The hosted page: the one that holds the owner key. */
export const HOSTED_SOURCE = '/hosted/(.*)';
/** Every page (not the hashed assets): never kept in a cache. */
export const PAGES_SOURCE = '/((?!assets/).*)';

/** The checkout loader the hosted embed page names (and nothing else of the checkout's origin). */
export const V3_LOADER_URL = 'https://pay.elisym.network/v3/embed.js';

/** The admin CSP's load-bearing directives, exactly, with the page's own `connect-src`. */
export function adminCsp(connectSrc: string[]): Record<string, string[]> {
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'connect-src': connectSrc,
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'object-src': ["'none'"],
    'worker-src': ["'none'"],
  };
}

/** No opener handle, no referrer, no sniffing, no powerful features, on every path. */
export const ADMIN_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export interface VercelConfig {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
  redirects?: { source: string; destination: string; permanent?: boolean }[];
  rewrites?: { source: string; destination: string }[];
}

/** Problems with `vercel.json`: both CSPs, the shared headers, caching, and the `/hosted` routes. */
export function vercelProblems(vercel: VercelConfig, hostedConnect: string[]): string[] {
  const sources = cspSources(vercel);
  const twoSources =
    sources.length === 2 && sources.includes(SELF_HOST_SOURCE) && sources.includes(HOSTED_SOURCE);
  const redirect = vercel.redirects?.find((rule) => rule.source === '/hosted');
  const [firstRewrite] = vercel.rewrites ?? [];
  return [
    ...(twoSources
      ? []
      : [
          `CSP rules are on ${sources.join(', ')}: must be exactly ${SELF_HOST_SOURCE} and ${HOSTED_SOURCE}`,
        ]),
    ...cspProblems(cspOf(vercel, SELF_HOST_SOURCE), adminCsp(['wss:']), SELF_HOST_SOURCE),
    ...cspProblems(cspOf(vercel, HOSTED_SOURCE), adminCsp(hostedConnect), HOSTED_SOURCE),
    ...headerProblems(vercel, ADMIN_HEADERS),
    // The pages that hold a key are never kept in a cache (nor, in most browsers, the back/forward cache).
    ...headerProblems(vercel, { 'Cache-Control': 'no-store' }, PAGES_SOURCE),
    ...(redirect?.destination === '/hosted/' && redirect.permanent === false
      ? []
      : ['/hosted must redirect to /hosted/ (else the self-host page and its CSP would serve it)']),
    ...(firstRewrite?.source === HOSTED_SOURCE && firstRewrite.destination === '/hosted/index.html'
      ? []
      : [`the first rewrite must send ${HOSTED_SOURCE} to /hosted/index.html`]),
  ];
}

/**
 * Marks of the relay read code (nostr-tools' pool and relay, the self-host
 * session): none may reach the page that holds the owner key, whose CSP lets
 * it connect to the PayCore API only. (`wss://` itself is no mark: the hex
 * helpers' module holds nostr-tools' `normalizeURL`.)
 */
export const RELAY_CODE_MARKS = ['subscribeMany', '"REQ"', "'REQ'"] as const;

const ASSET_RE = /^\/assets\/([\w.-]+\.js)$/;
const CHUNK_IMPORT_RE = /(?:from|import)\s*\(?\s*["']\.\/([\w.-]+\.js)["']/g;

/** The scripts a page loads: its module script and its modulepreloads, by asset file name. */
function pageScripts(html: string): string[] {
  const tags = html.match(/<(?:script|link)\b[^>]*>/g) ?? [];
  return tags.flatMap((tag) => {
    const isScript = tag.startsWith('<script');
    const isPreload = /\brel="modulepreload"/.test(tag);
    if (!isScript && !isPreload) {
      return [];
    }
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1] ?? '';
    const name = ASSET_RE.exec(url)?.[1];
    return name === undefined ? [] : [name];
  });
}

/** Every chunk a page can run: its scripts and, transitively, the chunks they import. */
export function reachableChunks(html: string, readChunk: (name: string) => string): string[] {
  const seen = new Set<string>();
  const queue = pageScripts(html);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const match of readChunk(next).matchAll(CHUNK_IMPORT_RE)) {
      const imported = match[1];
      if (imported !== undefined) {
        queue.push(imported);
      }
    }
  }
  return [...seen];
}

/** The hosted page's chunks that carry relay read code. */
export function hostedRelayProblems(html: string, readChunk: (name: string) => string): string[] {
  return reachableChunks(html, readChunk).flatMap((name) => {
    const code = readChunk(name);
    return RELAY_CODE_MARKS.filter((mark) => code.includes(mark)).map(
      (mark) => `${name} is loaded by /hosted/ and holds relay code (${mark})`,
    );
  });
}
