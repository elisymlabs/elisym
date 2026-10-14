// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HEADER_BAR,
  HEADER_DOCS_LINK,
  HEADER_LINK,
  HEADER_NAV,
  HEADER_ROW,
  LANDING_SECTIONS,
  PAGE_FRAME,
  QUICKSTART_URL,
} from '../src/constants';

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
      // The CSP has style-src 'self': an inline style attribute would be refused.
      expect(code).not.toMatch(/\bstyle=\{/);
      expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it('draws the focus ring in the readable accent, never the light-mode lime', () => {
    expect(readFileSync(join(SRC, 'app.css'), 'utf8')).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--accent-ink\);/,
    );
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

  it('spaces the logo mark from the name as the landing does', () => {
    const logo = readFileSync(join(ROOT, '../merchant-landing/src/components/Logo.tsx'), 'utf8');
    const gap = logo.match(/<a [^>]*className="flex items-center (gap-\d+)"/)?.[1];
    expect(gap).toBeDefined();
    for (const name of ['AuthLayout.tsx', 'DashboardHeader.tsx']) {
      const code = readFileSync(join(SRC, 'components', name), 'utf8');
      expect(code).toMatch(
        new RegExp(`<span className="flex items-center ${gap ?? ''}"[^>]*>\\s*<LogoMark`),
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

  it('is the landing header, class for class: bar, row, nav and links', () => {
    expect(tokens(classOf(/<header className="([^"]+)"/))).toEqual(tokens(HEADER_BAR));
    expect(tokens(classOf(/<div className="([^"]+)"/))).toEqual(
      tokens(HEADER_ROW).filter((token) => token !== 'w-full'),
    );
    expect(tokens(classOf(/<nav className="([^"]+)"/))).toEqual(tokens(HEADER_NAV));
    expect(tokens(classOf(/key=\{item\.href\}[^>]*className="([^"]+)"/s))).toEqual(
      tokens(HEADER_LINK),
    );
    expect(tokens(classOf(/href=\{DOCS\.quickstart\}[^>]*className="([^"]+)"/s))).toEqual(
      tokens(HEADER_DOCS_LINK),
    );
  });

  it('links the landing sections the landing header links, and the same docs page', () => {
    const items = [...landing.matchAll(/\{ href: '#([a-z-]+)', label: '([^']+)' \}/g)].map(
      (match) => ({ id: match[1], label: match[2] }),
    );
    expect(items).toEqual(LANDING_SECTIONS);
    const constants = readFileSync(join(ROOT, '../merchant-landing/src/constants.ts'), 'utf8');
    expect(constants).toContain(`quickstart: '${QUICKSTART_URL}'`);
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
