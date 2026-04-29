/**
 * Write agent files: elisym.yaml, .secrets.json, .gitignore, and create agent dirs.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { encryptSecret, isEncrypted } from '../primitives/encryption';
import { agentPaths, type AgentPaths } from './paths';
import { elisymRootFor, type AgentSource } from './resolver';
import { ElisymYamlSchema, SecretsSchema, type ElisymYaml, type Secrets } from './schema';

const GITIGNORE_CONTENT = [
  '# elisym private state - do not commit.',
  '.secrets.json',
  '.media-cache.json',
  '.jobs.json',
  '.jobs.json.corrupt.*',
  '.customer-history.json',
  '.contacts.json',
  '',
].join('\n');

export interface CreateAgentDirOptions {
  target: AgentSource;
  name: string;
  cwd: string;
  /**
   * For `target: 'project'`: if no .elisym/ dir exists above cwd,
   * where should we create one? Defaults to cwd.
   */
  projectRoot?: string;
}

export interface CreatedAgentDir {
  dir: string;
  paths: AgentPaths;
  source: AgentSource;
  createdNewElisymRoot: boolean;
}

/**
 * Create (or reuse) the directory layout for a new agent. Idempotent: if the
 * agent directory already exists, returns its paths without overwriting.
 * Writes `.gitignore` in project-local .elisym/ on first creation.
 */
export async function createAgentDir(options: CreateAgentDirOptions): Promise<CreatedAgentDir> {
  const { target, name, cwd, projectRoot } = options;

  const existingRoot = elisymRootFor(target, cwd);
  let elisymRoot: string;
  let createdNewElisymRoot = false;

  if (existingRoot) {
    elisymRoot = existingRoot;
  } else if (target === 'project') {
    elisymRoot = join(projectRoot ?? cwd, '.elisym');
    createdNewElisymRoot = true;
  } else {
    throw new Error('homeElisymDir should always exist conceptually - this is unreachable');
  }

  const agentDir = join(elisymRoot, name);
  const mode = target === 'home' ? 0o700 : 0o755;
  await mkdir(agentDir, { recursive: true, mode });
  await mkdir(join(agentDir, 'skills'), { recursive: true, mode });

  if (target === 'project') {
    const gitignorePath = join(elisymRoot, '.gitignore');
    await writeFileIfMissing(gitignorePath, GITIGNORE_CONTENT, 0o644);
  }

  return {
    dir: agentDir,
    paths: agentPaths(agentDir),
    source: target,
    createdNewElisymRoot,
  };
}

/** Write elisym.yaml atomically. Validates via Zod before writing. */
export async function writeYaml(agentDir: string, yaml: ElisymYaml): Promise<void> {
  const validated = ElisymYamlSchema.parse(yaml);
  const body = YAML.stringify(validated);
  const target = agentPaths(agentDir).yaml;
  await writeFileAtomic(target, body, 0o644);
}

/**
 * Write .secrets.json atomically. If `passphrase` is given, encrypts all
 * plaintext secret fields (already-encrypted values are left as-is).
 * Generic over `llm_api_keys` so any registered provider's key is
 * encrypted without per-provider plumbing here.
 */
export async function writeSecrets(
  agentDir: string,
  secrets: Secrets,
  passphrase?: string,
): Promise<void> {
  const validated = SecretsSchema.parse(secrets);
  let encryptedLlmKeys: Record<string, string> | undefined;
  if (validated.llm_api_keys) {
    encryptedLlmKeys = {};
    for (const [providerId, value] of Object.entries(validated.llm_api_keys)) {
      if (value) {
        encryptedLlmKeys[providerId] = maybeEncrypt(value, passphrase);
      }
    }
    if (Object.keys(encryptedLlmKeys).length === 0) {
      encryptedLlmKeys = undefined;
    }
  }
  const finalSecrets: Secrets = {
    nostr_secret_key: maybeEncrypt(validated.nostr_secret_key, passphrase),
    solana_secret_key: validated.solana_secret_key
      ? maybeEncrypt(validated.solana_secret_key, passphrase)
      : undefined,
    llm_api_keys: encryptedLlmKeys,
  };
  const body = JSON.stringify(finalSecrets, null, 2) + '\n';
  const target = agentPaths(agentDir).secrets;
  await writeFileAtomic(target, body, 0o600);
}

function maybeEncrypt(value: string, passphrase: string | undefined): string {
  if (!passphrase) {
    return value;
  }
  if (isEncrypted(value)) {
    return value;
  }
  return encryptSecret(value, passphrase);
}

/** Atomic write: temp file + rename. Preserves mode. */
export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${randomBytes(6).toString('hex')}`;
  await writeFile(tmpPath, data, { mode });
  try {
    await rename(tmpPath, path);
  } catch (e) {
    // Best-effort cleanup of temp file on rename failure.
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

async function writeFileIfMissing(path: string, data: string, mode: number): Promise<void> {
  try {
    await writeFile(path, data, { mode, flag: 'wx' });
  } catch (e: unknown) {
    // wx fails with EEXIST if file exists - that's fine.
    if (!isEexist(e)) {
      throw e;
    }
  }
}

function isEexist(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'EEXIST'
  );
}
