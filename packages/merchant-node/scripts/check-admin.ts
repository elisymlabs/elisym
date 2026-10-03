/**
 * Checks the admin page bundle after a build, and fails the build when:
 * - it is over its size budget;
 * - it imports a Node built-in (`node:`), which no browser can load;
 * - a static file the admin server serves is missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { ADMIN_FILES } from '../src/admin-server';

const ADMIN_DIR = new URL('../dist/admin/', import.meta.url);

/** The admin bundle's budget, gzipped. */
const BUNDLE_BUDGET_BYTES = 100 * 1024;

const NODE_IMPORT_RE = /(?:from\s*|import\s*\(?\s*)["']node:/;

const problems: string[] = [];
for (const file of Object.values(ADMIN_FILES)) {
  if (!existsSync(new URL(file.name, ADMIN_DIR))) {
    problems.push(`dist/admin/${file.name} is missing`);
  }
}
const bundle = readFileSync(new URL('app.js', ADMIN_DIR));
const gzipped = gzipSync(bundle).length;
console.log(
  `admin app.js  ${(gzipped / 1024).toFixed(1)} KB gzip (budget ${BUNDLE_BUDGET_BYTES / 1024})`,
);
if (gzipped > BUNDLE_BUDGET_BYTES) {
  problems.push('the admin bundle is over its size budget');
}
if (NODE_IMPORT_RE.test(bundle.toString('utf8'))) {
  problems.push('the admin bundle imports a Node built-in (node:)');
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
