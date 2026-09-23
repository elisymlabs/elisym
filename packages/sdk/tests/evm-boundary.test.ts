/**
 * The EVM rail lives in `@elisym/pay-core/evm`, and pay-core's own suite keeps
 * it out of pay-core's root entry. This is the SDK's half: nothing in the SDK
 * but its `./evm` subpath may reach the rail, so `@elisym/sdk` - which every
 * browser client imports - never pulls it in.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const DIST = join(__dirname, '..', 'dist');
/** The one SDK file allowed to name the rail: the `@elisym/sdk/evm` re-export. */
const EVM_SUBPATH = 'evm.ts';

// A comment may sit between `import(` and its specifier - `import(/* x */ './evm')`
// - and esbuild keeps it, so both the source and the bundle forms allow one.
const COMMENTS = String.raw`(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*`;
const IMPORT_FORMS = String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*${COMMENTS}|\brequire\s*\(\s*${COMMENTS})`;
const RAIL_REFERENCE = new RegExp(
  IMPORT_FORMS +
    String.raw`['"](?:(?:\.\.?/)+(?:[\w-]+/)*evm(?:/[^'"]*)?|@elisym/(?:sdk|pay-core)/evm)['"]`,
);
const VIEM_REFERENCE = new RegExp(IMPORT_FORMS + String.raw`['"]viem(?:/[^'"]*)?['"]`);
/** A sentence only the rail carries, for looking inside a built bundle. */
const RAIL_MARKER = 'No elisym config contract is registered for';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the SDK keeps the EVM rail behind @elisym/sdk/evm', () => {
  const files = sourceFiles(SRC).filter((path) => relative(SRC, path) !== EVM_SUBPATH);

  it('finds the sources it guards', () => {
    // A sweep that finds nothing proves nothing. A floor, not a count: the SDK
    // has some eighty source files.
    expect(files.length).toBeGreaterThan(60);
  });

  it('imports the rail, or an EVM library, from nowhere but the evm subpath', () => {
    const offenders = files.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return RAIL_REFERENCE.test(source) || VIEM_REFERENCE.test(source);
    });
    expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
  });

  it('catches every form of the reference', () => {
    for (const line of [
      "import { x } from '@elisym/pay-core/evm';",
      "export * from '@elisym/pay-core/evm';",
      "const m = await import('@elisym/pay-core/evm');",
      "require('@elisym/sdk/evm');",
      "import { x } from '../evm';",
      "const rail = () => import(/* rail */ '@elisym/pay-core/evm');",
      "const rail = () => import(\n  // rail\n  '@elisym/pay-core/evm');",
    ]) {
      expect(RAIL_REFERENCE.test(line), line).toBe(true);
    }
    expect(RAIL_REFERENCE.test("import { x } from '@elisym/pay-core';")).toBe(false);
  });

  it('keeps the rail out of the built root bundle', () => {
    // turbo makes this package's `test` depend on its `build`, so inside
    // `bun qa` this reads fresh output.
    for (const name of ['index.js', 'index.cjs']) {
      const bundle = join(DIST, name);
      expect(existsSync(bundle), `dist/${name} is missing - build @elisym/sdk first`).toBe(true);
      const built = readFileSync(bundle, 'utf8');
      expect(built).not.toMatch(/@elisym\/(?:sdk|pay-core)\/evm/);
      expect(built).not.toContain(RAIL_MARKER);
      expect(built).not.toContain('viem');
    }
  });
});
