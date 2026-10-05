/**
 * The frozen loader sources: once a loader's SRI is published, its source and
 * the protocol subset it uses are never edited again (a change ships as a new
 * loader). `embed-prod/frozen.sha256` lists each file's sha256; the build
 * fails on any difference, so an edit cannot pass its tests yet never ship.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The frozen loader sources, relative to the package. */
export const FROZEN_DIRS = ['src/embed/v1', 'src/embed/v2', 'src/embed/v3'];
export const FROZEN_MANIFEST = 'embed-prod/frozen.sha256';

function frozenFiles(packageDir: string): string[] {
  return FROZEN_DIRS.flatMap((dir) =>
    readdirSync(join(packageDir, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(packageDir, join(entry.parentPath, entry.name))),
  ).sort();
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The manifest for the sources as they are now (`sha256sum` format). */
export function frozenManifest(packageDir: string): string {
  return frozenFiles(packageDir)
    .map((path) => `${sha256Of(join(packageDir, path))}  ${path}\n`)
    .join('');
}

/** What differs from the manifest: a changed, missing or unlisted file. */
export function frozenProblems(packageDir: string): string[] {
  const listed = new Map<string, string>();
  for (const line of readFileSync(join(packageDir, FROZEN_MANIFEST), 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      listed.set(match[2], match[1]);
    }
  }
  const found = frozenFiles(packageDir);
  const problems: string[] = [];
  for (const path of found) {
    const expected = listed.get(path);
    if (expected === undefined) {
      problems.push(`${path} is not in ${FROZEN_MANIFEST}`);
    } else if (expected !== sha256Of(join(packageDir, path))) {
      problems.push(`${path} changed: a frozen loader is never edited (ship a new loader)`);
    }
  }
  for (const path of listed.keys()) {
    if (!found.includes(path)) {
      problems.push(`${path} is listed in ${FROZEN_MANIFEST} but missing`);
    }
  }
  if (listed.size === 0) {
    problems.push(`${FROZEN_MANIFEST} lists nothing`);
  }
  return problems;
}
