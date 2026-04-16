import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = resolve(HERE, '../../target/idl/elisym_config.json');
const OUT_DIR = resolve(HERE, 'src/generated');

// Skip generation when the Anchor IDL is absent (CI) and generated sources are committed.
if (!existsSync(IDL_PATH)) {
  if (existsSync(resolve(OUT_DIR, 'index.ts'))) {
    console.log('IDL not found, using committed generated sources.');
    process.exit(0);
  }
  console.error(
    `IDL not found at ${IDL_PATH} and no generated sources exist. Run 'anchor build' first.`,
  );
  process.exit(1);
}

const { rootNodeFromAnchor } = await import('@codama/nodes-from-anchor');
const { renderVisitor } = await import('@codama/renderers-js');
const { createFromRoot } = await import('codama');

const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));
codama.accept(renderVisitor(OUT_DIR));
