// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const CORE_DIR = join(ROOT, '../merchant-node/src/admin');

/** The merchant-node admin modules this app may use: no DOM building, no node-only code. */
const ALLOWED_CORE = ['session', 'history', 'reader', 'store', 'key', 'labels'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function imports(code: string): string[] {
  return [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('the admin source', () => {
  const sources = files(SRC).filter((path) => /\.(ts|tsx)$/.test(path));

  it('reads the shared admin code only through lib/core, and only the allowed modules', () => {
    for (const path of sources) {
      for (const target of imports(readFileSync(path, 'utf8'))) {
        if (target.startsWith('@merchant-admin-core/')) {
          expect(relative(SRC, path)).toBe(join('lib', 'core.ts'));
          expect(ALLOWED_CORE).toContain(target.slice('@merchant-admin-core/'.length));
        }
        expect(target).not.toMatch(/merchant-node/);
      }
    }
  });

  it('the shared modules import neither the DOM page nor its renderer', () => {
    for (const name of ALLOWED_CORE) {
      const code = readFileSync(join(CORE_DIR, `${name}.ts`), 'utf8');
      for (const target of imports(code)) {
        expect(target).not.toMatch(/^\.\/(render|page)$/);
      }
    }
  });

  it('loads no checkout loader and renders no raw HTML', () => {
    for (const path of sources) {
      const code = readFileSync(path, 'utf8');
      expect(code).not.toMatch(/@elisym\/react|pay\.elisym\.network/);
      expect(code).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it('asks for the key only in a tab it claimed as its own', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toMatch(/const ownTab = claimWindow\(window\);/);
    expect(main).toMatch(/ownTab=\{ownTab\}/);
  });

  it('builds the session for every listing of the store', () => {
    expect(readFileSync(join(SRC, 'App.tsx'), 'utf8')).toMatch(/readAllListings: true/);
  });

  it('names commands the merchant CLI has', async () => {
    const { LOCAL_ADMIN_COMMAND, STORE_KEY_COMMAND } = await import('../src/constants');
    const cli = readFileSync(join(ROOT, '../merchant-node/src/cli.ts'), 'utf8');
    for (const command of [LOCAL_ADMIN_COMMAND, STORE_KEY_COMMAND]) {
      expect(command.startsWith('npx @elisym/merchant-node ')).toBe(true);
      const subcommand = command.split(' ')[2] ?? '';
      expect(cli).toMatch(new RegExp(`\\n  ${subcommand} `));
    }
  });
});
