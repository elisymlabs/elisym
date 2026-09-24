/**
 * `@elisym/sdk/agent-store` and `@elisym/sdk/node` read constants and a store
 * guard from the payment core, never the payment rail: they take them from
 * `@elisym/pay-core/shared`, which loads no Solana library. Reaching the core's
 * root entry instead - one re-export is enough - would load `@solana/kit` and
 * the program clients into every process that only manages agents.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = join(__dirname, '..', 'dist');
const LIGHT_ENTRIES = ['agent-store', 'node'];
const EXTERNAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"./][^'"]*)['"]/g;

function externalImports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(EXTERNAL_IMPORT)].map((match) => match[1] ?? '');
}

describe('light SDK entries stay off the payment rail', () => {
  for (const entry of LIGHT_ENTRIES) {
    for (const extension of ['js', 'cjs']) {
      it(`${entry}.${extension} reads the core through ./shared only`, () => {
        const file = join(DIST, `${entry}.${extension}`);
        expect(
          existsSync(file),
          `dist/${entry}.${extension} is missing - build @elisym/sdk first`,
        ).toBe(true);
        const imports = externalImports(file);
        expect(imports).toContain('@elisym/pay-core/shared');
        // Of the core's entries only `./shared` is light: the root, `./evm` and
        // `./internal` all reach chunks that load Solana libraries.
        const heavy = imports.filter(
          (specifier) =>
            (specifier.startsWith('@elisym/pay-core') && specifier !== '@elisym/pay-core/shared') ||
            specifier.startsWith('@solana/') ||
            specifier.startsWith('@solana-program/'),
        );
        expect(heavy).toEqual([]);
      });
    }
  }
});

describe('the SDK root types', () => {
  // `moduleResolution: node10` does not read `exports`, so a subpath such as
  // `@elisym/pay-core/shared` cannot be resolved there: named in the root's
  // declarations, it would turn those exports into `any` for such a consumer
  // (or an error with skipLibCheck off). The package root resolves through
  // `types`, so the root entry names only that.
  for (const name of ['index.d.ts', 'index.d.cts']) {
    it(`${name} references no pay-core subpath`, () => {
      const file = join(DIST, name);
      expect(existsSync(file), `dist/${name} is missing - build @elisym/sdk first`).toBe(true);
      expect(readFileSync(file, 'utf8')).not.toMatch(/['"]@elisym\/pay-core\/[^'"]+['"]/);
    });
  }
});

describe('shipped code', () => {
  // `@elisym/pay-core/internal` is free to change in any release: an installed
  // package that imported it could break on a pay-core patch.
  const PACKAGES = join(__dirname, '..', '..');
  const INTERNAL = /['"]@elisym\/pay-core\/internal['"]/;

  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        return name === 'node_modules' || name === 'dist' ? [] : sources(path);
      }
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('never imports @elisym/pay-core/internal', () => {
    // Every package's shipped sources: `src/`, and `app/` for the web app.
    const roots = readdirSync(PACKAGES)
      .flatMap((name) => [join(PACKAGES, name, 'src'), join(PACKAGES, name, 'app')])
      .filter((path) => existsSync(path));
    expect(roots.length).toBeGreaterThan(3);
    const offenders = roots
      .flatMap(sources)
      .filter((path) => INTERNAL.test(readFileSync(path, 'utf8')))
      .map((path) => relative(PACKAGES, path));
    expect(offenders).toEqual([]);
  });
});
