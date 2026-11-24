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
export const FROZEN_DIRS = ['src/embed/v1', 'src/embed/v2', 'src/embed/v3', 'src/embed/v4'];
export const FROZEN_MANIFEST = 'embed-prod/frozen.sha256';
/**
 * Loaders whose pinned bytes are on `main` and so in merchants' pages: never
 * frozen again. A loader joins in the commit that first merges it to `main`;
 * `tests/loader-pins.test.ts` holds each one's pin, so taking one out shows.
 */
export const RELEASED_LOADERS: readonly string[] = ['v1', 'v2', 'v3'];
/** The test that holds each loader's pin, one `  vN: 'sha384-...',` line per loader. */
export const PIN_TEST = 'tests/loader-pins.test.ts';

/** Why `scripts/freeze.ts --loader <loader>` must not run, checked before anything else. */
export function freezeRefusal(
  loader: string,
  released: readonly string[] = RELEASED_LOADERS,
): string | undefined {
  if (!/^v[1-9][0-9]*$/.test(loader)) {
    return `${JSON.stringify(loader)} is not a loader name (v1, v2, ...)`;
  }
  if (released.includes(loader)) {
    return `${loader} is released: merchants pin its bytes, publish a changed loader under a new path`;
  }
  return undefined;
}

/** `text` (the pin test) with `loader`'s pin line set to `sri`; throws unless exactly one line is found. */
export function withPin(text: string, loader: string, sri: string): string {
  if (!/^v[1-9][0-9]*$/.test(loader) || !/^sha384-[A-Za-z0-9+/]{64}$/.test(sri)) {
    throw new Error(`not a loader and its sha384 pin: ${loader} ${sri}`);
  }
  const line = new RegExp(`^  ${loader}: 'sha384-[A-Za-z0-9+/]{64}',$`, 'gm');
  const found = text.match(line)?.length ?? 0;
  if (found !== 1) {
    throw new Error(`${PIN_TEST} holds ${found} pin lines for ${loader}, not one`);
  }
  return text.replace(line, `  ${loader}: '${sri}',`);
}

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
