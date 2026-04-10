/**
 * single source of truth for the package version. `index.ts` surfaces this string
 * via `commander`'s `--version`, so we read it from `package.json` at module load
 * instead of hardcoding a literal that can drift apart from the published version.
 *
 * Mirrors the same approach used in `@elisym/mcp` (`packages/mcp/src/utils.ts`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
  try {
    // dist/index.js -> ../package.json (npm always ships package.json at the package root)
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export const PACKAGE_VERSION: string = readPackageVersion();
