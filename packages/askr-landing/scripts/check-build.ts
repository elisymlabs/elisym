/** Fails the build when the site is not safe to deploy (`deploy-checks.ts` says what that takes). */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deployProblems } from './deploy-checks';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const sourcePages = readdirSync(new URL('..', import.meta.url)).filter((file) =>
  file.endsWith('.html'),
);
const problems = deployProblems(
  fileURLToPath(new URL('../dist/', import.meta.url)),
  vercel,
  sourcePages,
);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('landing build checks passed');
