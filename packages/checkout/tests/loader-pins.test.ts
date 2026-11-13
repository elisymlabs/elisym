import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { frozenProblems } from '../scripts/frozen';
import {
  BUILD_ENTRY,
  LOADER_HOSTS,
  V4_ORIGIN_PLACEHOLDER,
  hostCopyPath,
  hostRewrite,
  loaderForOrigin,
  readV4Manifest,
  v4Problems,
  vercelV4Problems,
} from '../scripts/loader-hosts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

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
  for (const path of [
    'src/embed/v1',
    'src/embed/v2',
    'src/embed/v3',
    'src/embed/v4',
    'src/embed/v4.sri',
    'embed-prod',
  ]) {
    cpSync(join(PACKAGE_DIR, path), join(dir, path), { recursive: true });
  }
  return dir;
}

describe('the pinned loaders', () => {
  it('the committed bytes are the ones merchants pin', () => {
    for (const version of ['v1', 'v2', 'v3']) {
      const pinned = readFileSync(join(PACKAGE_DIR, 'src', 'embed', `${version}.sri`), 'utf8');
      expect(sriOf(join(PACKAGE_DIR, 'embed-prod', version, 'embed.js'))).toBe(pinned.trim());
    }
    expect(readFileSync(join(PACKAGE_DIR, 'src', 'embed', 'v1.sri'), 'utf8').trim()).toBe(
      'sha384-n2Bj5LKM3OGGlQOwpooaauimc99mLR+4ookl8AeVpG3GjG4aLBc7jV1l2WEljNhH',
    );
    // Pinned by merchants once live: a change here must be a new version, never these bytes.
    expect(readFileSync(join(PACKAGE_DIR, 'src', 'embed', 'v2.sri'), 'utf8').trim()).toBe(
      'sha384-XM3Y69QJCGeQZMDRkZsoggZJgFT0DqK9jHpMNx1dDDEHAVcjP62KsLd8vjsgE0gJ',
    );
    expect(readFileSync(join(PACKAGE_DIR, 'src', 'embed', 'v3.sri'), 'utf8').trim()).toBe(
      'sha384-FPsJfAuhwQU0mlPKTKLwCTp1YGK6aFRh0pT+Gl1T3UML2jlIK7EkW8FW5ue2qFJX',
    );
  });

  it('are served with CORS (SRI fails without it) and an immutable cache', () => {
    const config = JSON.parse(readFileSync(join(PACKAGE_DIR, 'vercel.json'), 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    for (const source of ['/v1/(.*)', '/v2/(.*)', '/v3/(.*)', '/v4/(.*)', '/v4-hosts/(.*)']) {
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

const VERCEL_PATH = join(PACKAGE_DIR, 'vercel.json');

function vercelConfig() {
  return JSON.parse(readFileSync(VERCEL_PATH, 'utf8')) as Parameters<typeof vercelV4Problems>[0];
}

describe('loader v4, one frozen copy per checkout hostname', () => {
  it('every loader host has its pinned copy: the template with its own origin', () => {
    expect(LOADER_HOSTS).toEqual(['pay.elisym.network']);
    expect(v4Problems(PACKAGE_DIR)).toEqual([]);
    const manifest = readV4Manifest(PACKAGE_DIR);
    expect([...manifest.keys()]).toEqual(['template', 'pay.elisym.network']);
    // Pinned by merchants once live: a change here must be a new version, never these bytes.
    expect(manifest.get('pay.elisym.network')).toBe(
      'sha384-CdMU0h8JtYzyYG0yyumOljA4+jCMNSgMUdumd6EQ26pG0EmLA+zZ4JzgCbvK835C',
    );
    const copy = readFileSync(join(PACKAGE_DIR, hostCopyPath('pay.elisym.network')), 'utf8');
    expect(copy).toContain('"https://pay.elisym.network"');
    expect(copy).not.toContain(V4_ORIGIN_PLACEHOLDER);
  });

  it("vercel.json reaches each copy by Host, the build's own copy last", () => {
    expect(vercelV4Problems(vercelConfig())).toEqual([]);
    expect(hostRewrite('pay.elisym.network')).toEqual({
      source: '/v4/embed.js',
      has: [{ type: 'host', value: 'pay\\.elisym\\.network' }],
      destination: '/v4-hosts/pay.elisym.network/embed.js',
    });
  });

  it('fails on an edited copy, template or manifest, and on a host without a copy', () => {
    const editedCopy = scratchPackage();
    const copyPath = join(editedCopy, hostCopyPath('pay.elisym.network'));
    writeFileSync(copyPath, `${readFileSync(copyPath, 'utf8')};`);
    expect(v4Problems(editedCopy)).toEqual([
      'embed-prod/pay.elisym.network/v4/embed.js is not the template for https://pay.elisym.network',
      `embed-prod/pay.elisym.network/v4/embed.js is not the pinned ${readV4Manifest(PACKAGE_DIR).get('pay.elisym.network')}`,
    ]);

    const editedTemplate = scratchPackage();
    const templatePath = join(editedTemplate, 'embed-prod/v4/embed.template.js');
    writeFileSync(templatePath, `${readFileSync(templatePath, 'utf8')};`);
    expect(v4Problems(editedTemplate)).toEqual([
      'embed-prod/v4/embed.template.js is not the template pinned in src/embed/v4.sri',
      'embed-prod/pay.elisym.network/v4/embed.js is not the template for https://pay.elisym.network',
    ]);

    const extra = scratchPackage();
    const manifestPath = join(extra, 'src/embed/v4.sri');
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, 'utf8')}sha384-${'A'.repeat(64)}  pay.partner.example\n`,
    );
    expect(v4Problems(extra)).toEqual([
      'src/embed/v4.sri lists pay.partner.example, which is not a loader host',
    ]);

    expect(v4Problems(scratchPackage(), [...LOADER_HOSTS, 'pay.partner.example'])).toEqual([
      'embed-prod/pay.partner.example/v4/embed.js is missing',
    ]);
    expect(v4Problems(scratchPackage(), ['Pay.Partner.Example'])).toEqual([
      'Pay.Partner.Example is not a lowercase hostname',
      'src/embed/v4.sri lists pay.elisym.network, which is not a loader host',
    ]);
  });

  it('fails on a missing, misplaced or extra v4 rewrite, and without the loader headers', () => {
    const config = vercelConfig();
    const rewrites = config.rewrites ?? [];
    const v4 = rewrites.filter((rewrite) => rewrite.source === '/v4/embed.js');
    const others = rewrites.filter((rewrite) => rewrite.source !== '/v4/embed.js');
    const routeProblem = expect.stringContaining('vercel.json must route /v4/embed.js by Host');
    expect(vercelV4Problems({ ...config, rewrites: [...others, ...v4].reverse() })).toEqual([
      routeProblem,
    ]);
    expect(vercelV4Problems({ ...config, rewrites: others })).toEqual([routeProblem]);
    expect(vercelV4Problems(config, [...LOADER_HOSTS, 'pay.partner.example'])).toEqual([
      routeProblem,
    ]);
    for (const source of ['/v4/(.*)', '/v4-hosts/(.*)']) {
      const headers = (config.headers ?? []).filter((rule) => rule.source !== source);
      expect(vercelV4Problems({ ...config, headers })).toEqual([
        `vercel.json serves ${source} without CORS and an immutable cache`,
      ]);
    }
    expect(BUILD_ENTRY).toBe('_build');
  });

  it('bakes only an origin that cannot leave its string literal', () => {
    const template = `a("${V4_ORIGIN_PLACEHOLDER}");b("${V4_ORIGIN_PLACEHOLDER}/checkout")`;
    expect(loaderForOrigin(template, 'https://pay.partner.example')).toBe(
      'a("https://pay.partner.example");b("https://pay.partner.example/checkout")',
    );
    expect(loaderForOrigin(template, 'http://127.0.0.1:5174')).toContain('"http://127.0.0.1:5174"');
    for (const origin of [
      'https://pay.partner.example/',
      'https://pay.partner.example:443',
      'https://pay.partner.example/path',
      'http://pay.partner.example',
      'https://pay"partner.example',
      'https://PAY.partner.example',
      'https://pay.partner.example\\',
    ]) {
      expect(() => loaderForOrigin(template, origin), origin).toThrow('cannot be baked');
    }
    expect(() => loaderForOrigin('a()', 'https://pay.partner.example')).toThrow(
      'no origin placeholder',
    );
  });
});

/** What merchants copy: every snippet that loads a loader. */
const SNIPPET_FILES = [
  '../docs/pages/commerce/widget.mdx',
  '../docs/pages/commerce/quickstart.mdx',
  '../docs/pages/commerce/credit-an-account.mdx',
  '../docs/pages/commerce/cloud-agents.mdx',
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
