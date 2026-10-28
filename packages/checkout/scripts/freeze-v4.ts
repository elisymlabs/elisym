/**
 * Writes each loader host's frozen v4 copy and its SRI from the committed
 * template: run after adding a hostname to the brand registry. An existing
 * host's bytes never change (they are the template with its own origin).
 *
 *   bun scripts/freeze-v4.ts             # host copies from the committed template
 *   bun scripts/freeze-v4.ts --template  # first freeze only: build the template too
 *
 * The template is built and written only while no template is pinned: once
 * `src/embed/v4.sri` names one, merchants may pin its copies, and a changed
 * loader ships as v5.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOADER_HOSTS,
  TEMPLATE_ENTRY,
  V4_MANIFEST,
  V4_TEMPLATE,
  hostCopyPath,
  loaderForOrigin,
  readV4Manifest,
  sriOf,
  v4ManifestText,
} from './loader-hosts';
import { buildV4Template } from './v4-template';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = readV4Manifest(PACKAGE_DIR);
const templatePath = join(PACKAGE_DIR, V4_TEMPLATE);

if (process.argv.includes('--template')) {
  if (manifest.has(TEMPLATE_ENTRY)) {
    throw new Error(`${V4_MANIFEST} already pins a template: a changed loader ships as v5`);
  }
  mkdirSync(dirname(templatePath), { recursive: true });
  writeFileSync(templatePath, await buildV4Template(PACKAGE_DIR));
  console.log(`wrote ${V4_TEMPLATE}`);
}
if (!existsSync(templatePath)) {
  throw new Error(`${V4_TEMPLATE} is missing: run with --template to freeze it first`);
}
const template = readFileSync(templatePath, 'utf8');
const pinnedTemplate = manifest.get(TEMPLATE_ENTRY);
if (pinnedTemplate !== undefined && pinnedTemplate !== sriOf(template)) {
  throw new Error(`${V4_TEMPLATE} is not the pinned template`);
}
manifest.set(TEMPLATE_ENTRY, sriOf(template));
for (const host of LOADER_HOSTS) {
  const copy = loaderForOrigin(template, `https://${host}`);
  const pinned = manifest.get(host);
  if (pinned !== undefined && pinned !== sriOf(copy)) {
    throw new Error(`${host}'s copy would change from the pinned ${pinned}`);
  }
  const path = join(PACKAGE_DIR, hostCopyPath(host));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, copy);
  manifest.set(host, sriOf(copy));
  console.log(`${hostCopyPath(host)}  ${sriOf(copy)}`);
}
writeFileSync(join(PACKAGE_DIR, V4_MANIFEST), v4ManifestText(manifest));
console.log(`wrote ${V4_MANIFEST}`);
