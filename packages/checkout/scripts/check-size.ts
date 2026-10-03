import { createHash } from 'node:crypto';
/**
 * Checks the build, and fails it when one does not hold:
 * - size budgets (plan: `embed.js` at most 5 KB gzip, the checkout's first
 *   screen at most 250 KB gzip);
 * - `v1/embed.js` adds no global to the merchant's page;
 * - `v1/embed.js` is served immutable and pinned by merchants with an SRI hash,
 *   so its bytes must never change under that path: they must match
 *   `src/embed/v1.sri`. A changed loader ships under a new path (`/v2/`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { PRODUCTION_ORIGIN, checkoutOrigin } from './build-env';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const EMBED_BUDGET = 5 * 1024;
const FIRST_SCREEN_BUDGET = 250 * 1024;

function gzipped(path: string): number {
  return gzipSync(readFileSync(path)).length;
}

// Only what is deployed: the fixture page and other dev files stay out of the build.
const DIST_ENTRIES = ['assets', 'index.html', 'v1'];
const extra = readdirSync(DIST).filter((entry) => !DIST_ENTRIES.includes(entry));
if (extra.length > 0) {
  console.error(`dist/ holds more than the deployment: ${extra.join(', ')}`);
  process.exit(1);
}

const embed = gzipped(join(DIST, 'v1', 'embed.js'));
// The first screen: every script and stylesheet the page loads up front.
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const upfront = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map(
  (match) => match[1] ?? '',
);
const firstScreen = upfront.reduce((total, asset) => total + gzipped(join(DIST, asset)), 0);
const assets = readdirSync(join(DIST, 'assets')).length;

console.log(`embed.js      ${(embed / 1024).toFixed(1)} KB gzip (budget ${EMBED_BUDGET / 1024})`);
console.log(
  `first screen  ${(firstScreen / 1024).toFixed(1)} KB gzip (budget ${FIRST_SCREEN_BUDGET / 1024}), ${upfront.length} of ${assets} assets`,
);
if (embed > EMBED_BUDGET || firstScreen > FIRST_SCREEN_BUDGET) {
  console.error('size budget exceeded');
  process.exit(1);
}

// The loader runs on the merchant's page: it must add nothing to its globals
// (a top-level `var` would overwrite the page's own).
const sandbox: Record<string, unknown> = {
  customElements: { get: () => undefined, define: () => undefined },
  // Only extended, never constructed, when the loader runs.
  HTMLElement: Object,
  URLSearchParams,
};
const loader = readFileSync(join(DIST, 'v1', 'embed.js'), 'utf8');
const before = new Set(Object.getOwnPropertyNames(sandbox));
runInNewContext(loader, sandbox);
const leaked = Object.getOwnPropertyNames(sandbox).filter((name) => !before.has(name));
// A top-level let, const or class is invisible to the sandbox yet shares the
// page's global scope: the file must be one expression statement (the IIFE).
const program = ts.createSourceFile('embed.js', loader, ts.ScriptTarget.Latest);
const oneExpression =
  program.statements.length === 1 && ts.isExpressionStatement(program.statements[0] as ts.Node);
if (leaked.length > 0 || !oneExpression) {
  console.error(
    `embed.js adds to the page's global scope: ${leaked.join(', ') || 'top-level statements'}`,
  );
  process.exit(1);
}

const sri = `sha384-${createHash('sha384')
  .update(readFileSync(join(DIST, 'v1', 'embed.js')))
  .digest('base64')}`;
const pinned = readFileSync(
  fileURLToPath(new URL('../src/embed/v1.sri', import.meta.url)),
  'utf8',
).trim();
console.log(`v1/embed.js   ${sri}`);
// Built for the production origin: the bytes must be the pinned ones. Built for
// another origin (a local demo, a preview): not the file merchants pin - but a
// production deployment never ships one.
const origin = checkoutOrigin(process.env);
if (origin !== PRODUCTION_ORIGIN && process.env.VERCEL_ENV === 'production') {
  console.error(`a production build must frame ${PRODUCTION_ORIGIN}, not ${origin}`);
  process.exit(1);
}
if (origin === PRODUCTION_ORIGIN && sri !== pinned) {
  console.error(
    `v1/embed.js changed (pinned ${pinned}): merchants pin these bytes; publish the new loader under /v2/ instead`,
  );
  process.exit(1);
}
