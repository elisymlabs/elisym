/**
 * Global (not per-agent) config stored at `~/.elisym/config.yaml`.
 *
 * Currently holds only session-spend-limit overrides; other top-level fields
 * may be added later. The loader tolerates a missing file (returns `{}`), but
 * fails fast on malformed YAML or schema violations.
 */

import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { writeFileAtomic } from '../agent-store/writer';

export const SessionSpendLimitEntrySchema = z
  .object({
    chain: z.enum(['solana']),
    token: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/, 'token must be lowercase alphanumeric'),
    mint: z.string().min(1).max(64).optional(),
    amount: z.number().positive().finite(),
  })
  .strict();

export const GlobalConfigSchema = z
  .object({
    session_spend_limits: z.array(SessionSpendLimitEntrySchema).max(16).optional(),
  })
  .strict();

export type SessionSpendLimitEntry = z.infer<typeof SessionSpendLimitEntrySchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

function isEnoent(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'ENOENT'
  );
}

/**
 * Read and validate `~/.elisym/config.yaml`. Returns `{}` if missing. Throws
 * on malformed YAML or schema violations — the MCP server treats these as fatal
 * at startup rather than silently ignoring bad overrides.
 */
export async function loadGlobalConfig(path: string): Promise<GlobalConfig> {
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
