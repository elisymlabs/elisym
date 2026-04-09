#!/usr/bin/env node
/**
 * Pre-publish preflight for @elisym/mcp.
 *
 * Fails loudly if the package is in a state that would break npm consumers:
 *   1. Any `workspace:` protocol in dependencies (would not resolve off-workspace).
 *   2. Missing LICENSE file (declared in `files` but on-disk).
 *   3. Missing dist/ build artifacts.
 *   4. `main` / `bin` targets don't exist on disk.
 *
 * Invoked via `prepublishOnly` script in package.json. Runs for both `npm publish`
 * and `bun publish`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const pkgPath = join(pkgRoot, 'package.json');

/** @type {{ dependencies?: Record<string,string>, peerDependencies?: Record<string,string>, bin?: Record<string,string>, main?: string, files?: string[] }} */
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const errors = [];

// (1) Reject workspace protocol.
const depGroups = [
  ['dependencies', pkg.dependencies ?? {}],
  ['peerDependencies', pkg.peerDependencies ?? {}],
  ['devDependencies', pkg.devDependencies ?? {}],
];
for (const [name, group] of depGroups) {
  for (const [dep, range] of Object.entries(group)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      errors.push(
        `  - ${name}["${dep}"] = "${range}" — workspace protocol must be replaced with a real semver range before publish.`,
      );
    }
  }
}

// (2) LICENSE file must exist so npm bundles it.
if (!existsSync(join(pkgRoot, 'LICENSE'))) {
  errors.push('  - LICENSE file is listed in `files` but does not exist in packages/mcp/.');
}

// (3) dist/index.js must exist and be executable for the `bin` field.
const distIndex = join(pkgRoot, 'dist', 'index.js');
if (!existsSync(distIndex)) {
  errors.push('  - dist/index.js does not exist. Run `bun run build` before publishing.');
}

// (4) Bin target(s) must exist.
const binEntries =
  typeof pkg.bin === 'string' ? [['default', pkg.bin]] : Object.entries(pkg.bin ?? {});
for (const [name, target] of binEntries) {
  const resolved = join(pkgRoot, target);
  if (!existsSync(resolved)) {
    errors.push(`  - bin["${name}"] -> "${target}" does not exist on disk.`);
  }
}

// (5) Main target must exist if declared.
if (pkg.main) {
  const mainResolved = join(pkgRoot, pkg.main);
  if (!existsSync(mainResolved)) {
    errors.push(`  - main -> "${pkg.main}" does not exist on disk.`);
  }
}

if (errors.length > 0) {
  console.error('\n[preflight-publish] @elisym/mcp is NOT ready to publish:\n');
  for (const e of errors) console.error(e);
  console.error('\nFix the issues above and retry.\n');
  process.exit(1);
}

console.error('[preflight-publish] @elisym/mcp preflight OK.');
