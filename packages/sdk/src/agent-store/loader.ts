/**
 * Load an agent: parse elisym.yaml + .secrets.json, decrypt if encrypted.
 */

import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { validateAgentName } from '../primitives/config';
import { isEncrypted, decryptSecret } from '../primitives/encryption';
import { agentPaths } from './paths';
import { resolveAgent, type AgentSource, type ResolvedAgent } from './resolver';
import { ElisymYamlSchema, SecretsSchema, type ElisymYaml, type Secrets } from './schema';

export interface LoadedAgent {
  name: string;
  dir: string;
  source: AgentSource;
  yaml: ElisymYaml;
  secrets: Secrets;
  /** true when at least one secret field was encrypted on disk. */
  encrypted: boolean;
  shadowsGlobal: boolean;
}

/** Raw resolve + read + parse, no decryption yet. Useful for ergonomic list views. */
export async function readAgentPublic(
  resolved: ResolvedAgent,
): Promise<{ resolved: ResolvedAgent; yaml: ElisymYaml }> {
  const paths = agentPaths(resolved.dir);
  const yamlRaw = await readFile(paths.yaml, 'utf-8');
  const parsed = YAML.parse(yamlRaw);
  const yaml = ElisymYamlSchema.parse(parsed ?? {});
  return { resolved, yaml };
}

/**
 * Load an agent by name. Searches project-local first, then home.
 * Throws with clear error if missing or if encrypted secrets lack a passphrase.
 */
export async function loadAgent(
  name: string,
  cwd: string,
  passphrase?: string,
): Promise<LoadedAgent> {
  validateAgentName(name);
  const resolved = resolveAgent(name, cwd);
  if (!resolved) {
    throw new Error(
      `Agent "${name}" not found. Looked for .elisym/${name}/elisym.yaml in project (walking up from ${cwd}) and in home (${homeElisymPathHint(name)}).`,
    );
  }
  return loadResolvedAgent(resolved, passphrase);
}

/** Load an agent whose location was already resolved. */
export async function loadResolvedAgent(
  resolved: ResolvedAgent,
  passphrase?: string,
): Promise<LoadedAgent> {
  const paths = agentPaths(resolved.dir);

  const yamlRaw = await readFile(paths.yaml, 'utf-8');
  const parsedYaml = YAML.parse(yamlRaw);
  const yaml = ElisymYamlSchema.parse(parsedYaml ?? {});

  let secretsRaw: string;
  try {
    secretsRaw = await readFile(paths.secrets, 'utf-8');
  } catch {
    throw new Error(
      `Agent "${resolved.name}" has elisym.yaml but no secrets at ${paths.secrets}. Run \`elisym init\` to initialize secrets.`,
    );
  }

  const secrets = SecretsSchema.parse(JSON.parse(secretsRaw));
  const encryptedFields = listEncryptedFields(secrets);

  const effectivePassphrase = passphrase ?? process.env.ELISYM_PASSPHRASE;
  if (encryptedFields.length > 0 && !effectivePassphrase) {
    throw new Error(
      `Agent "${resolved.name}" has encrypted secrets [${encryptedFields.join(', ')}]. Set ELISYM_PASSPHRASE or pass a passphrase.`,
    );
  }

  const decrypted: Secrets = { ...secrets };
  if (effectivePassphrase) {
    if (isEncrypted(decrypted.nostr_secret_key)) {
      decrypted.nostr_secret_key = decryptSecret(decrypted.nostr_secret_key, effectivePassphrase);
    }
    if (decrypted.solana_secret_key && isEncrypted(decrypted.solana_secret_key)) {
      decrypted.solana_secret_key = decryptSecret(decrypted.solana_secret_key, effectivePassphrase);
    }
    if (decrypted.llm_api_key && isEncrypted(decrypted.llm_api_key)) {
      decrypted.llm_api_key = decryptSecret(decrypted.llm_api_key, effectivePassphrase);
    }
  }

  const finalSecrets = applyLlmApiKeyEnvFallback(decrypted, yaml);

  return {
    name: resolved.name,
    dir: resolved.dir,
    source: resolved.source,
    yaml,
    secrets: finalSecrets,
    encrypted: encryptedFields.length > 0,
    shadowsGlobal: resolved.shadowsGlobal,
  };
}

function listEncryptedFields(secrets: Secrets): string[] {
  const out: string[] = [];
  if (isEncrypted(secrets.nostr_secret_key)) {
    out.push('nostr_secret_key');
  }
  if (secrets.solana_secret_key && isEncrypted(secrets.solana_secret_key)) {
    out.push('solana_secret_key');
  }
  if (secrets.llm_api_key && isEncrypted(secrets.llm_api_key)) {
    out.push('llm_api_key');
  }
  return out;
}

/** Fall back to ANTHROPIC_API_KEY / OPENAI_API_KEY env if llm_api_key is absent. */
function applyLlmApiKeyEnvFallback(secrets: Secrets, yaml: ElisymYaml): Secrets {
  if (secrets.llm_api_key) {
    return secrets;
  }
  if (!yaml.llm) {
    return secrets;
  }
  const envKey = yaml.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const value = process.env[envKey];
  if (!value) {
    return secrets;
  }
  return { ...secrets, llm_api_key: value };
}

function homeElisymPathHint(name: string): string {
  return `~/.elisym/${name}/elisym.yaml`;
}
