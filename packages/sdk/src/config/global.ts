/**
 * Global (not per-agent) config stored at `~/.elisym/config.yaml`.
 *
 * Node.js/Bun only - reads and writes the filesystem. Browser code must not
 * import this module; import the schemas from `./global-schema` instead, or
 * the loader/writer from `@elisym/sdk/node`.
 */

import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { isBlockingNode } from '../agent-store/node-type';
import { writeFileAtomic } from '../agent-store/writer';
import { GlobalConfigSchema, type GlobalConfig } from './global-schema';

export {
  GlobalConfigSchema,
  SessionSpendLimitEntrySchema,
  type GlobalConfig,
  type SessionSpendLimitEntry,
} from './global-schema';

function isEnoent(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'ENOENT'
  );
}

/**
 * Read and validate `~/.elisym/config.yaml`. Returns `{}` if missing. Throws
 * on malformed YAML or schema violations - the MCP server treats these as fatal
 * at startup rather than silently ignoring bad overrides.
 */
export async function loadGlobalConfig(path: string): Promise<GlobalConfig> {
  // The `.elisym` root is a directory other people can write to - a shared
  // project checkout, a machine with several operators - and a blocking node
  // here never settles the read, so the `catch` below would never run.
  if (await isBlockingNode(path)) {
    throw new Error(`Refusing to read ${path}: it is a pipe, socket or device, not a file`);
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    if (isEnoent(e)) {
      return {};
    }
    throw e;
  }
  if (raw.trim() === '') {
    return {};
  }
  const parsed: unknown = YAML.parse(raw);
  return GlobalConfigSchema.parse(parsed ?? {});
}

/** Write the config YAML atomically. Validates via Zod before writing. */
export async function writeGlobalConfig(path: string, config: GlobalConfig): Promise<void> {
  const validated = GlobalConfigSchema.parse(config);
  const body = YAML.stringify(validated);
  await writeFileAtomic(path, body, 0o644);
}
