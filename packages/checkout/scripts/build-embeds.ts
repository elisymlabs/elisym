/**
 * Builds the loaders into `dist/v1/`, `dist/v2/`, `dist/v3/` and `dist/v4-hosts/`. For the production origin
 * the committed bytes in `embed-prod/` are copied as they are: merchants pin
 * them with an SRI hash, so a toolchain update must never rebuild them. For any
 * other origin (a preview, a local demo) they are built from the frozen sources.
 *
 * v4 has one copy per checkout hostname (`scripts/loader-hosts.ts`): the
 * production origin (also a plain local build) gets every loader host's
 * committed copy, any other origin only its own (`v4-hosts/_build/`), baked
 * into the template built from source.
 *
 *   bun scripts/build-embeds.ts                # what `build` runs
 *   bun scripts/build-embeds.ts --from-source  # rebuild even for production (to compare)
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { PRODUCTION_ORIGIN, checkoutOrigin } from './build-env';
import {
  BUILD_ENTRY,
  LOADER_HOSTS,
  V4_HOSTS_DIR,
  hostCopyPath,
  loaderForOrigin,
} from './loader-hosts';
import { buildV4Template } from './v4-template';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const LOADERS = [
  { version: 'v1', config: 'vite.embed.config.ts' },
  { version: 'v2', config: 'vite.embed-v2.config.ts' },
  { version: 'v3', config: 'vite.embed-v3.config.ts' },
] as const;

const fromSource = process.argv.includes('--from-source');
for (const { version, config } of LOADERS) {
  if (checkoutOrigin(process.env) === PRODUCTION_ORIGIN && !fromSource) {
    mkdirSync(join(PACKAGE_DIR, 'dist', version), { recursive: true });
    copyFileSync(
      join(PACKAGE_DIR, 'embed-prod', version, 'embed.js'),
      join(PACKAGE_DIR, 'dist', version, 'embed.js'),
    );
    console.log(`${version}/embed.js copied from embed-prod/ (pinned bytes)`);
  } else {
    await build({ configFile: join(PACKAGE_DIR, config), logLevel: 'warn' });
    console.log(`${version}/embed.js built from source`);
  }
}

/** Puts one v4 copy at `dist/v4-hosts/<entry>/embed.js`. */
function writeV4(entry: string, bytes: string): void {
  const dir = join(PACKAGE_DIR, 'dist', V4_HOSTS_DIR, entry);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'embed.js'), bytes);
}

const origin = checkoutOrigin(process.env);
if (origin === PRODUCTION_ORIGIN && !fromSource) {
  for (const host of LOADER_HOSTS) {
    const dir = join(PACKAGE_DIR, 'dist', V4_HOSTS_DIR, host);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(PACKAGE_DIR, hostCopyPath(host)), join(dir, 'embed.js'));
    console.log(`v4 for ${host} copied from embed-prod/ (pinned bytes)`);
  }
} else {
  const template = await buildV4Template(PACKAGE_DIR);
  if (origin === PRODUCTION_ORIGIN) {
    for (const host of LOADER_HOSTS) {
      writeV4(host, loaderForOrigin(template, `https://${host}`));
      console.log(`v4 for ${host} built from source`);
    }
  } else {
    writeV4(BUILD_ENTRY, loaderForOrigin(template, origin));
    console.log(`v4 for ${origin} built from source`);
  }
}
