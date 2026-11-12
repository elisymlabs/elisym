// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ASKR_API_BASE, ASKR_RELAYS } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE, chunkProblems, htmlProblems } from '../scripts/build-checks';
import { cspSources, elementSnippet, scriptSnippet } from '../src/lib/embed';
import { percentOfBps, shareBps, usd } from '../src/lib/usage';

const SRC = new URL('../src/', import.meta.url).pathname;
const EM_DASH = String.fromCharCode(0x2014);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe('the source', () => {
  const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('has no em dash anywhere', () => {
    expect(files.filter((file) => file.text.includes(EM_DASH)).map((file) => file.path)).toEqual(
      [],
    );
  });

  it('never puts anything in browser storage, so no key outlives the tab', () => {
    expect(
      files
        .filter((file) => /localStorage|sessionStorage|indexedDB/.test(file.text))
        .map((file) => file.path),
    ).toEqual([]);
  });
});

describe('the embed snippet', () => {
  const npub = 'npub1example';

  it('loads widget.js from the API host with the store npub, or places the askr-chat element', () => {
    expect(scriptSnippet(npub)).toBe(
      `<script src="${ASKR_API_BASE}/widget.js" data-store="${npub}" async></script>`,
    );
    expect(elementSnippet(npub)).toContain(`<askr-chat store="${npub}"></askr-chat>`);
  });

  it('lists the API host for scripts and connections, and the relay for connections', () => {
    const byDirective = new Map(cspSources().map((source) => [source.directive, source.sources]));
    expect(byDirective.get('script-src')).toEqual([ASKR_API_BASE]);
    expect(byDirective.get('connect-src')).toEqual([ASKR_API_BASE, ...ASKR_RELAYS]);
    expect(byDirective.get('img-src')).toEqual(['https:']);
  });
});

describe('usage shares', () => {
  it('are basis points through decimals, capped, and zero on a zero limit', () => {
    expect(shareBps('0.5', '2')).toBe(2_500);
    expect(shareBps('0.1', '0.3')).toBe(3_333);
    expect(shareBps('9', '2')).toBe(10_000);
    expect(shareBps('1', '0')).toBe(0);
    expect(shareBps('x', '2')).toBe(0);
    expect(percentOfBps(3_333)).toBe('33.33');
    expect(usd('0.5')).toBe('$0.50');
  });
});

describe('the build checks', () => {
  it('refuse an inline script and files outside /admin/', () => {
    expect(htmlProblems(`<script type="module" src="${ADMIN_BASE}assets/a.js"></script>`)).toEqual(
      [],
    );
    expect(htmlProblems('<script>alert(1)</script>')).toContain('an inline <script>');
    expect(htmlProblems('<link href="/assets/a.css">')).toEqual([
      'loads /assets/a.css, which is not under /admin/',
    ]);
    expect(chunkProblems('a.js', 'import x from "node:fs"')).toEqual([
      'a.js imports a Node built-in',
    ]);
  });
});
