/**
 * Fails the build when the admin would not run under the server's CSP
 * (`script-src 'self'`): its page loads only its own files under /admin/,
 * with no inline script, and no chunk imports a Node built-in. The Shopify
 * app's embedded page loads App Bridge first and never touches browser storage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { chunkProblems, htmlProblems, shopifyHtmlProblems, storageProblems } from './build-checks';

const DIST = new URL('../dist/', import.meta.url);

const chunks = new Map(
  readdirSync(new URL('assets/', DIST))
    .filter((name) => name.endsWith('.js'))
    .map((name) => [`assets/${name}`, readFileSync(new URL(`assets/${name}`, DIST), 'utf8')]),
);
const shopifyHtml = readFileSync(new URL('shopify/index.html', DIST), 'utf8');
const problems = [
  ...htmlProblems(readFileSync(new URL('index.html', DIST), 'utf8')),
  ...shopifyHtmlProblems(shopifyHtml),
  ...storageProblems(shopifyHtml, chunks),
  ...[...chunks].flatMap(([name, code]) => chunkProblems(name, code)),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('admin build checks passed');
