/**
 * Fails the build when the admin is not safe to deploy: its two pages (`/`,
 * self-host, and `/hosted/`) load only their own files with no inline script,
 * no chunk names the checkout's origin (but the one loader URL) or a Node
 * built-in, and `vercel.json` sets each page's CSP on its own disjoint path:
 * the hosted page connects only to the committed API's origin, or nowhere.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { PAYCORE_API_BASE, PAYCORE_OPERATOR } from '../src/hosted/config';
import { hostedConnectSrc, readHostedConfig } from '../src/hosted/lib/hosted-config';
import { V3_LOADER_URL, type VercelConfig, vercelProblems } from './admin-checks';
import { chunkProblems, htmlProblems } from './build-checks';

const DIST = new URL('../dist/', import.meta.url);

const config = readHostedConfig(PAYCORE_API_BASE, PAYCORE_OPERATOR);
const vercel: VercelConfig = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
);

const problems = [
  ...(config.kind === 'invalid' ? [config.problem] : []),
  ...htmlProblems(readFileSync(new URL('index.html', DIST), 'utf8')),
  ...htmlProblems(readFileSync(new URL('hosted/index.html', DIST), 'utf8')),
  ...readdirSync(new URL('assets/', DIST))
    .filter((name) => name.endsWith('.js'))
    .flatMap((name) =>
      chunkProblems(
        name,
        readFileSync(new URL(`assets/${name}`, DIST), 'utf8'),
        ['pay.elisym.network'],
        [V3_LOADER_URL],
      ),
    ),
  ...vercelProblems(vercel, hostedConnectSrc(config)),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('admin build checks passed');
