#!/usr/bin/env node
/**
 * Pre-publish preflight for @elisym/cli.
 *
 * Fails loudly if the package is in a state that would break npm consumers:
 *   1. Any `workspace:` protocol in dependencies (would not resolve off-workspace).
 *   2. Missing dist/ build artifacts.
 *   3. `main` / `bin` targets don't exist on disk.
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

/** @type {{ dependencies?: Record<string,string>, peerDependencies?: Record<string,string>, devDependencies?: Record<string,string>, bin?: Record<string,string> | string, main?: string }} */
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

// (2) dist/index.js must exist for the `bin` and `main` fields.
const distIndex = join(pkgRoot, 'dist', 'index.js');
if (!existsSync(distIndex)) {
  errors.push('  - dist/index.js does not exist. Run `bun run build` before publishing.');
}

// (3) Bin target(s) must exist.
const binEntries =
  typeof pkg.bin === 'string' ? [['default', pkg.bin]] : Object.entries(pkg.bin ?? {});
for (const [name, target] of binEntries) {
  const resolved = join(pkgRoot, target);
  if (!existsSync(resolved)) {
    errors.push(`  - bin["${name}"] -> "${target}" does not exist on disk.`);
  }
}

// (4) Main target must exist if declared.
if (pkg.main) {
  const mainResolved = join(pkgRoot, pkg.main);
  if (!existsSync(mainResolved)) {
    errors.push(`  - main -> "${pkg.main}" does not exist on disk.`);
  }
}

if (errors.length > 0) {
  console.error('\n[preflight-publish] @elisym/cli is NOT ready to publish:\n');
  for (const e of errors) console.error(e);
  console.error('\nFix the issues above and retry.\n');
  process.exit(1);
}

console.error('[preflight-publish] @elisym/cli preflight OK.');
