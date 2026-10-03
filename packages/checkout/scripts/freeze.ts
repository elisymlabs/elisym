/**
 * Rewrites `embed-prod/frozen.sha256` from the frozen loader sources. Run only
 * when freezing a new loader (with its `embed-prod/vN/embed.js` and `vN.sri`),
 * never to make an edit to a frozen one pass.
 *
 *   bun scripts/freeze.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_MANIFEST, frozenManifest } from './frozen';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
writeFileSync(join(PACKAGE_DIR, FROZEN_MANIFEST), frozenManifest(PACKAGE_DIR));
console.log(`wrote ${FROZEN_MANIFEST}`);
