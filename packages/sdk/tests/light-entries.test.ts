/**
 * `@elisym/sdk/agent-store` and `@elisym/sdk/node` read constants and a store
 * guard from the payment core, never the payment rail: they take them from
 * `@elisym/pay-core/shared`, which loads no Solana library. Reaching the core's
 * root entry instead - one re-export is enough - would load `@solana/kit` and
 * the program clients into every process that only manages agents.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
        const heavy = imports.filter(
          (specifier) =>
            specifier === '@elisym/pay-core' ||
            specifier === '@elisym/pay-core/evm' ||
            specifier.startsWith('@solana/') ||
            specifier.startsWith('@solana-program/'),
        );
        expect(heavy).toEqual([]);
      });
    }
  }
});
