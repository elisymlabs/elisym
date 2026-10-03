/**
 * Builds the loaders into `dist/v1/` and `dist/v2/`. For the production origin
 * the committed bytes in `embed-prod/` are copied as they are: merchants pin
 * them with an SRI hash, so a toolchain update must never rebuild them. For any
 * other origin (a preview, a local demo) they are built from the frozen sources.
 *
 *   bun scripts/build-embeds.ts                # what `build` runs
 *   bun scripts/build-embeds.ts --from-source  # rebuild even for production (to compare)
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { PRODUCTION_ORIGIN, checkoutOrigin } from './build-env';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const LOADERS = [
  { version: 'v1', config: 'vite.embed.config.ts' },
  { version: 'v2', config: 'vite.embed-v2.config.ts' },
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
