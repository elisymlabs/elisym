import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PACKAGE_VERSION } from '../src/version.js';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

describe('PACKAGE_VERSION', () => {
  it('matches package.json version', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
