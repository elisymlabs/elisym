import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FROZEN_DIRS,
  RELEASED_LOADERS,
  freezeRefusal,
  frozenProblems,
  withPin,
} from '../scripts/frozen';
import { LOADER_GLOBALS, globalsAdded, globalsProblem } from '../scripts/leaks';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Each loader's pin, as merchants copy it. Pinned once live: a change must be
 * a new version, never these bytes. `scripts/freeze.ts --loader vN` rewrites
 * an unreleased loader's line; a released one's changes only by hand.
 */
const PINS: Readonly<Record<string, string>> = {
  v1: 'sha384-n2Bj5LKM3OGGlQOwpooaauimc99mLR+4ookl8AeVpG3GjG4aLBc7jV1l2WEljNhH',
  v2: 'sha384-XM3Y69QJCGeQZMDRkZsoggZJgFT0DqK9jHpMNx1dDDEHAVcjP62KsLd8vjsgE0gJ',
  v3: 'sha384-FPsJfAuhwQU0mlPKTKLwCTp1YGK6aFRh0pT+Gl1T3UML2jlIK7EkW8FW5ue2qFJX',
  v4: 'sha384-x6dXYbL43ZTUT6tSX44pwUJazMDSiOULx6bsJD2JVk+eooivU9FcyYcvLD43LwWV',
};
const LOADERS = Object.keys(PINS);

function sriOf(path: string): string {
  return `sha384-${createHash('sha384').update(readFileSync(path)).digest('base64')}`;
}

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of what the frozen check reads, to break on purpose. */
function scratchPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elisym-frozen-'));
  scratchDirs.push(dir);
  for (const path of [...FROZEN_DIRS, 'embed-prod']) {
    cpSync(join(PACKAGE_DIR, path), join(dir, path), { recursive: true });
  }
  return dir;
}

describe('the pinned loaders', () => {
  it('the committed bytes are the ones merchants pin', () => {
    for (const version of LOADERS) {
      const pinned = readFileSync(join(PACKAGE_DIR, 'src', 'embed', `${version}.sri`), 'utf8');
      expect(pinned, version).toBe(`${PINS[version]}\n`);
      expect(sriOf(join(PACKAGE_DIR, 'embed-prod', version, 'embed.js')), version).toBe(
        PINS[version],
      );
    }
  });

  it('every released loader has its pin here, and every loader is frozen', () => {
    expect(RELEASED_LOADERS).toEqual(['v1', 'v2', 'v3', 'v4']);
    for (const version of RELEASED_LOADERS) {
      expect(LOADERS).toContain(version);
    }
    expect(FROZEN_DIRS).toEqual(LOADERS.map((version) => `src/embed/${version}`));
  });

  it('add no global to the page, but v4 its one PayCore', () => {
    expect(Object.keys(LOADER_GLOBALS)).toEqual(LOADERS);
    for (const version of LOADERS) {
      const code = readFileSync(join(PACKAGE_DIR, 'embed-prod', version, 'embed.js'), 'utf8');
      expect(globalsAdded(code), version).toEqual(LOADER_GLOBALS[version]);
      expect(globalsProblem(version, code), version).toBeUndefined();
    }
    expect(LOADER_GLOBALS.v4).toEqual(['PayCore']);
  });

  it('are served with CORS (SRI fails without it) and an immutable cache', () => {
    const config = JSON.parse(readFileSync(join(PACKAGE_DIR, 'vercel.json'), 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    for (const source of LOADERS.map((version) => `/${version}/(.*)`)) {
      const rule = config.headers.find((each) => each.source === source);
      expect(rule?.headers).toEqual(
        expect.arrayContaining([
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ]),
      );
    }
  });
});

describe('the frozen loader sources', () => {
  it('match the manifest', () => {
    expect(frozenProblems(PACKAGE_DIR)).toEqual([]);
  });

  it('fail on an edit, a new file and a missing one', () => {
    const edited = scratchPackage();
    const embed = join(edited, 'src/embed/v2/embed.ts');
    writeFileSync(embed, `${readFileSync(embed, 'utf8')}\n// edited\n`);
    expect(frozenProblems(edited)).toEqual([
      'src/embed/v2/embed.ts changed: a frozen loader is never edited (ship a new loader)',
    ]);

    const added = scratchPackage();
    writeFileSync(join(added, 'src/embed/v1/extra.ts'), 'export {};\n');
    expect(frozenProblems(added)).toEqual([
      'src/embed/v1/extra.ts is not in embed-prod/frozen.sha256',
    ]);

    const missing = scratchPackage();
    rmSync(join(missing, 'src/embed/v1/entry.ts'));
    expect(frozenProblems(missing)).toEqual([
      'src/embed/v1/entry.ts is listed in embed-prod/frozen.sha256 but missing',
    ]);

    const emptied = scratchPackage();
    writeFileSync(join(emptied, 'embed-prod/frozen.sha256'), '');
    expect(frozenProblems(emptied)).toContain('embed-prod/frozen.sha256 lists nothing');
  });
});

/** What merchants copy: every snippet that loads a loader. */
const SNIPPET_FILES = [
  '../docs/pages/commerce/widget.mdx',
  '../docs/pages/commerce/quickstart.mdx',
  '../docs/pages/commerce/credit-an-account.mdx',
  '../merchant-node/README.md',
  '../../examples/demo-store/index.html',
];

describe('the snippets merchants copy', () => {
  it('pin each loader with its own hash, and new pages load v3', () => {
    const pins = new Map(
      ['v1', 'v2', 'v3'].map((version) => [
        version,
        readFileSync(join(PACKAGE_DIR, 'src', 'embed', `${version}.sri`), 'utf8').trim(),
      ]),
    );
    for (const file of SNIPPET_FILES) {
      const text = readFileSync(join(PACKAGE_DIR, file), 'utf8');
      const snippets = [
        ...text.matchAll(
          /src="https:\/\/pay\.elisym\.network\/(v\d+)\/embed\.js"\s+integrity="([^"]+)"/g,
        ),
      ];
      expect(snippets.length, file).toBeGreaterThan(0);
      for (const [, version, integrity] of snippets) {
        expect(version, file).toBe('v3');
        expect(integrity, file).toBe(pins.get(version ?? ''));
      }
    }
  });
});

describe('the global-scope check', () => {
  it('sees a global, a top-level declaration, a missing one and a loader that throws at load', () => {
    expect(globalsAdded('(function(){window.Extra=1})()')).toEqual(['Extra']);
    expect(globalsAdded('var leaked=1')).toEqual(['leaked', 'top-level statements']);
    expect(globalsAdded('const hidden=1;(function(){})()')).toEqual(['top-level statements']);
    expect(globalsAdded('(function(){})();let after=1')).toEqual(['top-level statements']);
    expect(globalsAdded('(function(){document.title})()')).toEqual(['throws at load']);
    expect(globalsAdded('(function(){window.PayCore={}})()')).toEqual(['PayCore']);
    // v4 must add exactly PayCore: nothing, or one more, fails.
    expect(globalsProblem('v4', '(function(){})()')).toBe(
      "v4/embed.js adds nothing to the page's global scope, not PayCore",
    );
    expect(globalsProblem('v4', '(function(){window.PayCore={};window.Other=1})()')).toContain(
      'Other, PayCore',
    );
    expect(globalsProblem('v3', '(function(){window.PayCore={}})()')).toBe(
      "v3/embed.js adds PayCore to the page's global scope, not nothing",
    );
    expect(globalsProblem('v9', '(function(){})()')).toBeDefined();
  });
});

describe('freezing a loader', () => {
  it('refuses a released loader and a bad name, before anything else', () => {
    for (const version of ['v1', 'v2', 'v3', 'v4']) {
      expect(freezeRefusal(version)).toContain(`${version} is released`);
    }
    expect(freezeRefusal('v5')).toBeUndefined();
    expect(freezeRefusal('v5', ['v5'])).toContain('v5 is released');
    for (const name of ['', 'v0', '4', 'v4/../v3', 'V4', 'v4 ']) {
      expect(freezeRefusal(name), name).toContain('is not a loader name');
    }
  });

  it('rewrites exactly the one pin line of the loader', () => {
    const text = readFileSync(join(PACKAGE_DIR, 'tests', 'loader-pins.test.ts'), 'utf8');
    const sri = `sha384-${'B'.repeat(64)}`;
    const rewritten = withPin(text, 'v4', sri);
    expect(rewritten).toContain(`  v4: '${sri}',`);
    expect(rewritten).not.toContain(`  v4: '${PINS.v4}',`);
    expect(rewritten.replace(`  v4: '${sri}',`, `  v4: '${PINS.v4}',`)).toBe(text);
    // No line, or two: refused.
    expect(() => withPin(text, 'v5', sri)).toThrow('0 pin lines for v5');
    const twice = `${text}\n  v4: '${PINS.v4}',\n`;
    expect(() => withPin(twice, 'v4', sri)).toThrow('2 pin lines for v4');
    expect(() => withPin(text, 'v4', 'sha384-short')).toThrow('not a loader');
    // Only a line that is exactly the pin counts: not an indented or commented copy.
    const pin = `sha384-${'C'.repeat(64)}`;
    for (const copy of [`    v4: '${pin}',`, `//  v4: '${pin}',`, `  v4: '${pin}', // old`]) {
      expect(() => withPin(copy, 'v4', sri), copy).toThrow('0 pin lines for v4');
      const both = `${copy}\n  v4: '${pin}',\n`;
      expect(withPin(both, 'v4', sri), copy).toBe(`${copy}\n  v4: '${sri}',\n`);
    }
  });
});
