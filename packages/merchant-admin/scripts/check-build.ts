/**
 * Fails the build when the admin is not safe to deploy: its page loads only
 * its own files with no inline script, no chunk names the checkout's origin or
 * a Node built-in, and `vercel.json` sets the admin CSP on every path.
 */
import { readFileSync, readdirSync } from 'node:fs';
import {
  chunkProblems,
  cspOfEveryPath,
  cspProblems,
  headerProblems,
  htmlProblems,
} from './build-checks';

const DIST = new URL('../dist/', import.meta.url);

/** The admin CSP's load-bearing directives, exactly. */
const ADMIN_CSP: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'connect-src': ['wss:'],
  'frame-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'object-src': ["'none'"],
  'worker-src': ["'none'"],
};

/** No opener handle, no referrer, no sniffing, on every path. */
const ADMIN_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

const problems = [
  ...htmlProblems(readFileSync(new URL('index.html', DIST), 'utf8')),
  ...readdirSync(new URL('assets/', DIST))
    .filter((name) => name.endsWith('.js'))
    .flatMap((name) =>
      chunkProblems(name, readFileSync(new URL(`assets/${name}`, DIST), 'utf8'), [
        'pay.elisym.network',
      ]),
    ),
  ...cspProblems(cspOfEveryPath(vercel), ADMIN_CSP),
  ...headerProblems(vercel, ADMIN_HEADERS),
  // The page that holds the key is never kept in a cache (nor, in most browsers, the back/forward cache).
  ...headerProblems(vercel, { 'Cache-Control': 'no-store' }, '/((?!assets/).*)'),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('admin build checks passed');
