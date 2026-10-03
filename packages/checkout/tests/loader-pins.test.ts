import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { frozenProblems } from '../scripts/frozen';

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
  for (const path of ['src/embed/v1', 'src/embed/v2', 'embed-prod']) {
    cpSync(join(PACKAGE_DIR, path), join(dir, path), { recursive: true });
  }
  return dir;
}

describe('the pinned loaders', () => {
  it('the committed bytes are the ones merchants pin', () => {
    for (const version of ['v1', 'v2']) {
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
  });

  it('are served with CORS (SRI fails without it) and an immutable cache', () => {
    const config = JSON.parse(readFileSync(join(PACKAGE_DIR, 'vercel.json'), 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    for (const source of ['/v1/(.*)', '/v2/(.*)']) {
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
