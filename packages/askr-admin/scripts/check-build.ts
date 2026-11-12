/**
 * Fails the build when the admin would not run under the server's CSP
 * (`script-src 'self'`): its page loads only its own files under /admin/,
 * with no inline script, and no chunk imports a Node built-in.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { chunkProblems, htmlProblems } from './build-checks';

const DIST = new URL('../dist/', import.meta.url);

const problems = [
  ...htmlProblems(readFileSync(new URL('index.html', DIST), 'utf8')),
  ...readdirSync(new URL('assets/', DIST))
    .filter((name) => name.endsWith('.js'))
    .flatMap((name) => chunkProblems(name, readFileSync(new URL(`assets/${name}`, DIST), 'utf8'))),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('admin build checks passed');
