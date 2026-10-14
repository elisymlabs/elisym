/**
 * The admin imports merchant-node's admin modules as source, and those resolve
 * their own dependencies from merchant-node's `node_modules`. This build check
 * fails when one package ends up in the bundle from two directories (two
 * copies of `nostr-tools`, say), which `resolve.dedupe` is meant to prevent.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/** A module's package: its name and the real directory of its `package.json`. */
export interface PackageOf {
  name: string;
  dir: string;
}

/** The package directories a name was bundled from, for every name bundled from more than one. */
export function duplicatePackages(packages: readonly PackageOf[]): Map<string, string[]> {
  const dirs = new Map<string, Set<string>>();
  for (const { name, dir } of packages) {
    dirs.set(name, (dirs.get(name) ?? new Set()).add(dir));
  }
  const duplicates = new Map<string, string[]>();
  for (const [name, found] of dirs) {
    if (found.size > 1) {
      duplicates.set(name, [...found].sort());
    }
  }
  return duplicates;
}

/**
 * The package a module file belongs to: the nearest `package.json` with a name.
 * Workspace packages resolve to their own folder, not under `node_modules`.
 */
function packageOf(file: string): PackageOf | undefined {
  let dir = dirname(realpathSync(file));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const name: unknown = JSON.parse(readFileSync(manifest, 'utf8')).name;
      if (typeof name === 'string' && name.length > 0) {
        return { name, dir };
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** Fails the build when a package is bundled from two directories. */
export function oneCopyOfEach(): Plugin {
  return {
    name: 'elisym-one-copy-of-each',
    generateBundle() {
      const packages: PackageOf[] = [];
      for (const id of this.getModuleIds()) {
        const file = id.split('?')[0] ?? id;
        if (file.startsWith('/') && existsSync(file)) {
          const found = packageOf(file);
          if (found !== undefined) {
            packages.push(found);
          }
        }
      }
      const duplicates = duplicatePackages(packages);
      if (duplicates.size > 0) {
        this.error(
          `packages bundled twice: ${[...duplicates].map(([name, dirs]) => `${name} (${dirs.join(', ')})`).join('; ')}`,
        );
      }
    },
  };
}
