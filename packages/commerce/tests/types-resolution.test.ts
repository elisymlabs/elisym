/**
 * A consumer on `moduleResolution: node10` (no `exports` support) still gets the
 * webhook types through `typesVersions`, and the root keeps resolving through
 * `types`. Reads the built `dist`, like the structure tests.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..');
const MODULE_RESOLUTION_KINDS = [ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Bundler];

let consumer: string | undefined;

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), 'commerce-types-'));
  mkdirSync(join(consumer, 'node_modules', '@elisym'), { recursive: true });
  symlinkSync(PACKAGE_ROOT, join(consumer, 'node_modules', '@elisym', 'commerce'), 'dir');
});

afterAll(() => {
  if (consumer !== undefined) {
    rmSync(consumer, { recursive: true, force: true });
  }
});

function resolvedUnder(moduleResolution: ts.ModuleResolutionKind, specifier: string): string {
  if (consumer === undefined) {
    throw new Error('consumer directory was not created');
  }
  const options: ts.CompilerOptions = {
    moduleResolution,
    module: ts.ModuleKind.ESNext,
    preserveSymlinks: false,
  };
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    join(consumer, 'index.ts'),
    options,
    ts.sys,
  );
  return resolvedModule?.resolvedFileName ?? '(unresolved)';
}

describe('type resolution for consumers', () => {
  for (const kind of MODULE_RESOLUTION_KINDS) {
    it(`resolves the root and the webhook subpath under ${ts.ModuleResolutionKind[kind]}`, () => {
      expect(resolvedUnder(kind, '@elisym/commerce')).toBe(
        join(PACKAGE_ROOT, 'dist', 'index.d.ts'),
      );
      expect(resolvedUnder(kind, '@elisym/commerce/webhook')).toBe(
        join(PACKAGE_ROOT, 'dist', 'webhook.d.ts'),
      );
    });
  }
});
