import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = resolve(HERE, '../../target/idl/elisym_config.json');
const OUT_DIR = resolve(HERE, 'src/generated');

const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));
codama.accept(renderVisitor(OUT_DIR));
