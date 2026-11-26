/**
 * Freezes the loader sources: `embed-prod/frozen.sha256` lists their hashes.
 *
 *   bun scripts/freeze.ts                # rewrite the manifest only
 *   bun scripts/freeze.ts --loader v4    # also build v4 and pin its bytes
 *
 * With `--loader vN` it builds `src/embed/vN/` for the production origin and
 * writes `embed-prod/vN/embed.js`, `src/embed/vN.sri`, vN's pin line in
 * `tests/loader-pins.test.ts` and the manifest. While vN is under review it is
 * frozen again in every commit that changes it, so the build stays green.
 *
 * It refuses, before touching anything, a loader in `RELEASED_LOADERS`, then
 * (fail closed) when `origin/main` cannot be fetched or already holds
 * `src/embed/vN.sri`: merchants pin those bytes. Never run it to make an edit
 * to a released loader pass: ship a new loader.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { PRODUCTION_ORIGIN } from './build-env';
import { FROZEN_MANIFEST, PIN_TEST, freezeRefusal, frozenManifest, withPin } from './frozen';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

function refuse(reason: string): never {
  console.error(`freeze: ${reason}`);
  process.exit(1);
}

/** Runs git in the package; `undefined` when it fails. */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return undefined;
  }
}

/** Fail closed: a loader whose pin is on `main` (or when that cannot be known) is never frozen again. */
function refuseReleasedOnMain(loader: string): void {
  if (git('fetch', 'origin', 'main') === undefined) {
    refuse('git fetch origin main failed: cannot tell whether the loader is released');
  }
  if (git('rev-parse', '--verify', 'origin/main') === undefined) {
    refuse('origin/main does not resolve: cannot tell whether the loader is released');
  }
  if (git('cat-file', '-e', `origin/main:./src/embed/${loader}.sri`) !== undefined) {
    refuse(`origin/main already holds src/embed/${loader}.sri: ${loader} is released`);
  }
}

/** The loader built from its sources for the production origin. */
async function builtForProduction(loader: string, config: string): Promise<Buffer> {
  const outDir = mkdtempSync(join(tmpdir(), 'elisym-freeze-'));
  const origin = process.env.CHECKOUT_ORIGIN;
  process.env.CHECKOUT_ORIGIN = PRODUCTION_ORIGIN;
  try {
    await build({
      configFile: config,
      build: { outDir, emptyOutDir: true },
      logLevel: 'warn',
    });
    return readFileSync(join(outDir, loader, 'embed.js'));
  } finally {
    if (origin === undefined) {
      delete process.env.CHECKOUT_ORIGIN;
    } else {
      process.env.CHECKOUT_ORIGIN = origin;
    }
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function freezeLoader(loader: string): Promise<void> {
  const refusal = freezeRefusal(loader);
  if (refusal !== undefined) {
    refuse(refusal);
  }
  const config = join(PACKAGE_DIR, `vite.embed-${loader}.config.ts`);
  if (!existsSync(config) || !existsSync(join(PACKAGE_DIR, 'src', 'embed', loader))) {
    refuse(`no vite.embed-${loader}.config.ts or src/embed/${loader}/`);
  }
  refuseReleasedOnMain(loader);
  // The bytes come from the sources as committed: formatted, so a format pass never changes them.
  const root = git('rev-parse', '--show-toplevel')?.trim();
  try {
    execFileSync('bunx', ['oxfmt', '--check', join(PACKAGE_DIR, 'src', 'embed', loader)], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    refuse(`src/embed/${loader}/ is not formatted: run bunx oxfmt on it first`);
  }
  const bytes = await builtForProduction(loader, config);
  const sri = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  const pinTest = join(PACKAGE_DIR, PIN_TEST);
  const pinned = withPin(readFileSync(pinTest, 'utf8'), loader, sri);
  mkdirSync(join(PACKAGE_DIR, 'embed-prod', loader), { recursive: true });
  writeFileSync(join(PACKAGE_DIR, 'embed-prod', loader, 'embed.js'), bytes);
  writeFileSync(join(PACKAGE_DIR, 'src', 'embed', `${loader}.sri`), `${sri}\n`);
  writeFileSync(pinTest, pinned);
  console.log(`froze ${loader}: ${sri}`);
}

const flag = process.argv.indexOf('--loader');
if (flag !== -1) {
  await freezeLoader(process.argv[flag + 1] ?? '');
}
writeFileSync(join(PACKAGE_DIR, FROZEN_MANIFEST), frozenManifest(PACKAGE_DIR));
console.log(`wrote ${FROZEN_MANIFEST}`);
