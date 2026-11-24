// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { V3_LOADER_URL } from '../scripts/admin-checks';
import {
  HEADER_BAR,
  HEADER_HOME_LINK,
  HEADER_NAV,
  HEADER_ROW,
  LANDING_URL,
  PAGE_FRAME,
} from '../src/constants';

const ROOT = new URL('../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const CORE_DIR = join(ROOT, '../merchant-node/src/admin');
/** The one source file that may name the checkout loader URL (A9). */
const EMBED_CONSTANTS = join('hosted', 'lib', 'embed-constants.ts');

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

/** Files that read the relays (the self-host session and its relay client): never run by `/hosted/`. */
const FORBIDDEN_FOR_HOSTED_FILES = [join('lib', 'core.ts'), join('lib', 'deps.ts')];
/** Packages and aliases of relay code: the shared admin core, the buyer relay client, nostr-tools' pools and relays (its root re-exports them). */
const FORBIDDEN_FOR_HOSTED_PACKAGES =
  /^(@merchant-admin-core|@elisym\/commerce\/buyer$|nostr-tools$|nostr-tools\/(pool|abstract-pool|relay|abstract-relay)$)/;

/** The value imports of `code` (`import type` and `export type` lines are erased by the build). */
function valueImports(code: string): string[] {
  return [
    ...code.matchAll(/^\s*(import|export)(?!\s+type\b)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gms),
    ...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
  ].map((match) => match[2] ?? match[1] ?? '');
}

function resolveSource(from: string, target: string): string | undefined {
  const base = join(from, '..', target);
  return ['', '.ts', '.tsx', join('', 'index.ts'), join('', 'index.tsx')]
    .map((ending) => (ending.startsWith('index') ? join(base, ending) : `${base}${ending}`))
    .find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
}

/** Every source file (relative to `src`) and every package a module runs, transitively. */
function walkFrom(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    for (const target of valueImports(readFileSync(path, 'utf8'))) {
      if (!target.startsWith('.')) {
        packages.add(target);
        continue;
      }
      const resolved = resolveSource(path, target);
      if (resolved === undefined) {
        throw new Error(`${path}: cannot resolve ${target}`);
      }
      queue.push(resolved);
    }
  }
  return { files: [...seen].map((path) => relative(SRC, path)), packages: [...packages] };
}

function hostedGraph() {
  return walkFrom(join(SRC, 'hosted', 'main.tsx'));
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

  it('renders no raw HTML and sets no inline style, anywhere in src', () => {
    for (const path of sources) {
      const code = readFileSync(path, 'utf8');
      expect(code, path).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      );
      // The CSP has style-src 'self': an inline style attribute would be refused.
      expect(code, path).not.toMatch(/\bstyle=\{/);
    }
  });

  it('loads no checkout loader; only the embed constants name its one v3 URL', () => {
    for (const path of sources) {
      const code = readFileSync(path, 'utf8');
      expect(code, path).not.toMatch(/@elisym\/react/);
      const named = code.match(/pay\.elisym\.network/g) ?? [];
      if (relative(SRC, path) === EMBED_CONSTANTS) {
        const exact = code.split(V3_LOADER_URL).length - 1;
        expect(named).toHaveLength(exact);
        expect(code, path).not.toMatch(
          new RegExp(`${V3_LOADER_URL.replace(/[./]/g, '\\$&')}[\\w./?#%&=:-]`),
        );
      } else {
        expect(named, path).toEqual([]);
      }
    }
  });

  it('touches browser storage only where hosted mode keeps a sealed key or the tab session', () => {
    for (const path of sources) {
      const code = readFileSync(path, 'utf8');
      const file = relative(SRC, path);
      expect(code, file).not.toMatch(/document\.cookie/);
      if (file !== join('hosted', 'lib', 'remembered.ts')) {
        expect(code, file).not.toMatch(/localStorage|indexedDB/);
      }
      if (file !== join('hosted', 'lib', 'tab-session.ts')) {
        expect(code, file).not.toMatch(/sessionStorage/);
      }
    }
  });

  it('reads the product rules only by their own alias, from hosted mode, and they stay a leaf', () => {
    for (const path of sources) {
      for (const target of imports(readFileSync(path, 'utf8'))) {
        if (target.startsWith('@merchant-product-rules')) {
          expect(target).toBe('@merchant-product-rules');
          expect(relative(SRC, path).startsWith(`hosted${sep}`)).toBe(true);
        }
      }
    }
    const rules = readFileSync(join(ROOT, '../merchant-node/src/product-rules.ts'), 'utf8');
    expect(imports(rules).sort()).toEqual(['decimal.js-light', 'zod']);
  });

  it('keeps hosted mode off the relay session code, through every import it runs', () => {
    const graph = hostedGraph();
    // The walk reaches the shared pieces hosted mode uses, so it is no empty pass.
    expect(graph.files).toContain(join('components', 'TxLink.tsx'));
    expect(graph.files).toContain(join('lib', 'short.ts'));
    expect(graph.files).toContain(join('lib', 'csv-cell.ts'));
    for (const file of graph.files) {
      expect(FORBIDDEN_FOR_HOSTED_FILES, file).not.toContain(file);
    }
    for (const target of graph.packages) {
      expect(target).not.toMatch(FORBIDDEN_FOR_HOSTED_PACKAGES);
    }
  });

  it('finds relay code reached through a shared file, as the walk is transitive', () => {
    expect(walkFrom(join(SRC, 'components', 'Dashboard.tsx')).files).toContain(
      join('lib', 'core.ts'),
    );
  });

  it('draws the focus ring in the readable accent, never the light-mode lime', () => {
    expect(readFileSync(join(SRC, 'app.css'), 'utf8')).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--accent-ink\);/,
    );
  });

  it('asks for a key only in a tab it claimed as its own, on both pages', () => {
    for (const entry of ['main.tsx', join('hosted', 'main.tsx')]) {
      const main = readFileSync(join(SRC, entry), 'utf8');
      expect(main, entry).toMatch(/const ownTab = claimWindow\(window\);/);
      expect(main, entry).toMatch(/ownTab=\{ownTab\}/);
    }
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

describe('the page frame', () => {
  it('is the landing header’s width, gutters and height, so the logo holds its place', () => {
    const landing = readFileSync(
      join(ROOT, '../merchant-landing/src/components/SiteHeader.tsx'),
      'utf8',
    );
    const frame = landing.match(/<div className="([^"]*max-w-[^"]*)"/)?.[1]?.split(' ') ?? [];
    const tokens = PAGE_FRAME.split(' ').filter((token) => token !== 'w-full');
    expect(frame).toEqual(expect.arrayContaining([...tokens, 'h-64']));
    expect(frame.filter((token) => /^(max-w|px|sm:px)-/.test(token)).sort()).toEqual(
      tokens.filter((token) => /^(max-w|px|sm:px)-/.test(token)).sort(),
    );
  });

  it('spaces the logo from what follows it as the landing does', () => {
    const logo = readFileSync(join(ROOT, '../merchant-landing/src/components/Logo.tsx'), 'utf8');
    const gap = logo.match(/<a [^>]*className="flex items-center (gap-\d+)"/)?.[1];
    expect(gap).toBeDefined();
    for (const name of ['AuthLayout.tsx', 'DashboardHeader.tsx']) {
      const code = readFileSync(join(SRC, 'components', name), 'utf8');
      expect(code).toMatch(
        new RegExp(
          `<span className="flex items-center ${gap ?? ''}"[^>]*>\\s*<(?:LogoMark|PayCoreLogo)`,
        ),
      );
    }
  });

  it('leaves no other page width in the admin', () => {
    for (const path of files(SRC).filter((path) => /\.(ts|tsx)$/.test(path))) {
      for (const width of readFileSync(path, 'utf8').match(/max-w-1\d{3}/g) ?? []) {
        expect(width).toBe('max-w-1160');
      }
    }
  });
});

describe('the header', () => {
  const landing = readFileSync(
    join(ROOT, '../merchant-landing/src/components/SiteHeader.tsx'),
    'utf8',
  );
  const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean).sort();
  const classOf = (pattern: RegExp) => landing.match(pattern)?.[1] ?? '';

  it('is the landing header, class for class: bar, row and nav', () => {
    expect(tokens(classOf(/<header className="([^"]+)"/))).toEqual(tokens(HEADER_BAR));
    expect(tokens(classOf(/<div className="([^"]+)"/))).toEqual(
      tokens(HEADER_ROW).filter((token) => token !== 'w-full'),
    );
    expect(tokens(classOf(/<nav className="([^"]+)"/))).toEqual(tokens(HEADER_NAV));
  });

  it('draws its one link as the landing draws a header link, but at every width', () => {
    const link = tokens(classOf(/key=\{item\.href\}[^>]*className="([^"]+)"/s));
    const shared = link.filter((token) => token !== 'hidden' && !token.includes(':inline'));
    expect(link.length).toBeGreaterThan(shared.length);
    expect(tokens(HEADER_HOME_LINK)).toEqual(expect.arrayContaining(shared));
    expect(tokens(HEADER_HOME_LINK)).not.toContain('hidden');
  });
});

describe('the header links and logo', () => {
  const auth = readFileSync(join(SRC, 'components/AuthLayout.tsx'), 'utf8');

  it('has one link: home, to the landing', () => {
    expect(auth.match(/<a /g)).toHaveLength(1);
    expect(auth).toMatch(/href=\{LANDING_URL\} className=\{HEADER_HOME_LINK\}/);
    expect(LANDING_URL).toBe('https://paycore.elisym.network');
  });

  it('draws the logo block with the landing logo classes, in order', () => {
    const landingLogo = readFileSync(
      join(ROOT, '../merchant-landing/src/components/Logo.tsx'),
      'utf8',
    );
    const classes = (code: string) =>
      [...code.matchAll(/className="([^"]+)"/g)].map((match) => match[1] ?? '');
    const wanted = classes(landingLogo);
    const found = classes(auth);
    const start = found.indexOf(wanted[0] ?? '');
    expect(wanted.length).toBeGreaterThan(2);
    expect(found.slice(start, start + wanted.length)).toEqual(wanted);
  });
});

describe('the header colors', () => {
  /** `--name: value` pairs of a CSS block, by name. */
  const tokensIn = (block: string) =>
    new Map(
      [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]),
    );
  const schemes = (path: string) => {
    const css = readFileSync(path, 'utf8');
    const [base = '', other = ''] = css.split('@media (prefers-color-scheme');
    const light = css.includes('@media (prefers-color-scheme: light)');
    const first = tokensIn(base);
    const second = tokensIn(other.split('@theme')[0] ?? '');
    return light ? { dark: first, light: second } : { light: first, dark: second };
  };

  it('match the landing in both schemes: the bar, its line, the links and the badge', () => {
    const admin = schemes(join(ROOT, 'src/app.css'));
    const landing = schemes(join(ROOT, '../merchant-landing/src/app.css'));
    for (const scheme of ['light', 'dark'] as const) {
      for (const name of ['bg', 'line', 'line-2', 'surface-2', 'text', 'text-2', 'text-3']) {
        expect(admin[scheme].get(name), `${scheme} --${name}`).toBe(landing[scheme].get(name));
      }
    }
  });
});
