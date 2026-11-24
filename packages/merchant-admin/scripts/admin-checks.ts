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
