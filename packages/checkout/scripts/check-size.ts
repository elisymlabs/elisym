import { createHash } from 'node:crypto';
/**
 * Checks the build, and fails it when one does not hold:
 * - size budgets (plan: `v1` to `v3/embed.js` at most 5 KB gzip, `v4` 7 KB,
 *   the checkout's first screen at most 250 KB gzip);
 * - no loader adds a global to the merchant's page, but v4's one `PayCore`;
 * - the loaders are served immutable and pinned by merchants with an SRI hash,
 *   so their bytes never change under their path: the committed
 *   `embed-prod/vN/embed.js` matches `src/embed/vN.sri`, and a production
 *   build serves exactly those bytes. A changed loader ships under a new path;
 * - the frozen loader sources match `embed-prod/frozen.sha256`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PRODUCTION_ORIGIN, checkoutOrigin } from './build-env';
import { frozenProblems } from './frozen';
import { globalsProblem } from './leaks';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PACKAGE_DIR, 'dist');
const FIRST_SCREEN_BUDGET = 250 * 1024;
/**
 * Each loader's gzip budget: v4 carries `PayCore.open` on top of v3. The gzip size of the same
 * bytes differs between zlib builds (v4: 6112 B here, 6152 B on Vercel), so a budget keeps room.
 */
const LOADERS = [
  { version: 'v1', budget: 5 * 1024 },
  { version: 'v2', budget: 5 * 1024 },
  { version: 'v3', budget: 5 * 1024 },
  { version: 'v4', budget: 7 * 1024 },
] as const;

const problems: string[] = [];

function gzipped(path: string): number {
  return gzipSync(readFileSync(path)).length;
}

function sriOf(path: string): string {
  return `sha384-${createHash('sha384').update(readFileSync(path)).digest('base64')}`;
}

// Only what is deployed: the fixture page and other dev files stay out of the build.
const DIST_ENTRIES: readonly string[] = [
  'assets',
  'index.html',
  ...LOADERS.map(({ version }) => version),
];
const extra = readdirSync(DIST).filter((entry) => !DIST_ENTRIES.includes(entry));
if (extra.length > 0) {
  problems.push(`dist/ holds more than the deployment: ${extra.join(', ')}`);
}

// The first screen: every script and stylesheet the page loads up front.
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const upfront = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map(
  (match) => match[1] ?? '',
);
const firstScreen = upfront.reduce((total, asset) => total + gzipped(join(DIST, asset)), 0);
const assets = readdirSync(join(DIST, 'assets')).length;
console.log(
  `first screen  ${(firstScreen / 1024).toFixed(1)} KB gzip (budget ${FIRST_SCREEN_BUDGET / 1024}), ${upfront.length} of ${assets} assets`,
);
if (firstScreen > FIRST_SCREEN_BUDGET) {
  problems.push('the first screen is over its size budget');
}

const origin = checkoutOrigin(process.env);
if (origin !== PRODUCTION_ORIGIN && process.env.VERCEL_ENV === 'production') {
  problems.push(`a production build must frame ${PRODUCTION_ORIGIN}, not ${origin}`);
}
for (const { version, budget } of LOADERS) {
  const built = join(DIST, version, 'embed.js');
  const size = gzipped(built);
  console.log(
    `${version}/embed.js  ${size} B gzip (${(size / 1024).toFixed(1)} KB, budget ${budget / 1024})`,
  );
  if (size > budget) {
    problems.push(`${version}/embed.js is over its size budget`);
  }
  const leaked = globalsProblem(version, readFileSync(built, 'utf8'));
  if (leaked !== undefined) {
    problems.push(leaked);
  }
  const pinned = readFileSync(join(PACKAGE_DIR, 'src', 'embed', `${version}.sri`), 'utf8').trim();
  if (sriOf(join(PACKAGE_DIR, 'embed-prod', version, 'embed.js')) !== pinned) {
    problems.push(`embed-prod/${version}/embed.js is not the pinned ${pinned}`);
  }
  const sri = sriOf(built);
  console.log(`${version}/embed.js  ${sri}`);
  // Built for the production origin: the bytes must be the pinned ones. Built for
  // another origin (a local demo, a preview): not the file merchants pin - but a
  // production deployment never ships one.
  if (origin === PRODUCTION_ORIGIN && sri !== pinned) {
    problems.push(
      `${version}/embed.js changed (pinned ${pinned}): merchants pin these bytes; publish a changed loader under a new path`,
    );
  }
}

problems.push(...frozenProblems(PACKAGE_DIR));
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
